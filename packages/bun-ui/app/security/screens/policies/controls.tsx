/**
 * One control per kind of schema node (see `schema.ts`): a select for an
 * enumeration, a checkbox, a number, a text, a duration (written with its
 * unit, `"5m"`), a list of strings (one per line), a set of choices, a
 * section that can be off, and the JSON editor for the rest. Each takes
 * the value and reports the next one; an emptied control reports
 * `undefined` (not set). Used by the generated forms and the hand-built
 * row editors alike.
 */
import type { Control } from "./schema";
import { useState } from "react";
import { JsonEditor } from "../../../kit/components/JsonEditor";
import {
  Checkbox,
  NumberInput,
  Select,
  TextInput,
} from "../../../kit/components/inputs";

/** Props of {@link FieldControl}. */
export interface FieldControlProps {
  /** The kind of control. */
  control: Control;
  /** The value shown. */
  value: unknown;
  /** Reports the next value; `undefined` unsets it. */
  onChange: (value: unknown) => void;
  /** Read-only. */
  disabled?: boolean;
  /** The control's accessible name. */
  label: string;
  /** A test id for the control. */
  testId?: string;
}

/** A duration as text (`"5m"`; an object of units as JSON). */
function durationText(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** The JSON editor for a value, applied when it parses. */
function JsonControl({
  value,
  onChange,
  disabled,
  label,
  testId,
}: Omit<FieldControlProps, "control">) {
  const [text, setText] = useState(() =>
    value === undefined ? "" : JSON.stringify(value, null, 2),
  );
  return (
    <div data-testid={testId}>
      <JsonEditor
        value={text}
        aria-label={label}
        rows={6}
        allowEmpty
        readOnly={disabled === true}
        onChange={(state) => {
          setText(state.text);
          if (state.error === null) onChange(state.value);
        }}
      />
    </div>
  );
}

/** See the module's description. */
export function FieldControl(props: FieldControlProps) {
  const { control, value, onChange, disabled = false, label, testId } = props;
  switch (control.kind) {
    case "enum": {
      const options = [
        { value: "", label: "(not set)" },
        ...control.values.map((v) => ({ value: String(v), label: String(v) })),
      ];
      return (
        <Select
          aria-label={label}
          data-testid={testId}
          disabled={disabled}
          options={options}
          value={
            typeof value === "string" || typeof value === "number"
              ? String(value)
              : ""
          }
          onChange={(next) => {
            if (next === "") onChange(undefined);
            else {
              const number = control.values.find(
                (v) => typeof v === "number" && String(v) === next,
              );
              onChange(number ?? next);
            }
          }}
        />
      );
    }
    case "boolean":
      return (
        <Checkbox
          label={label}
          data-testid={testId}
          disabled={disabled}
          checked={value === true}
          onChange={(checked) => onChange(checked)}
        />
      );
    case "number":
      return (
        <NumberInput
          aria-label={label}
          data-testid={testId}
          disabled={disabled}
          value={typeof value === "number" ? value : undefined}
          {...(control.min === undefined ? {} : { min: control.min })}
          {...(control.max === undefined ? {} : { max: control.max })}
          step={control.integer ? 1 : "any"}
          onChange={(next) => onChange(next)}
        />
      );
    case "string":
      return (
        <TextInput
          aria-label={label}
          data-testid={testId}
          disabled={disabled}
          value={typeof value === "string" ? value : ""}
          onChange={(next) => onChange(next === "" ? undefined : next)}
        />
      );
    case "duration":
      return (
        <TextInput
          aria-label={label}
          data-testid={testId}
          disabled={disabled}
          placeholder='a duration with its unit: "30s", "5m", "1h"'
          value={durationText(value)}
          onChange={(next) => onChange(next.trim() === "" ? undefined : next)}
        />
      );
    case "lines":
      return (
        <textarea
          className="input"
          aria-label={label}
          data-testid={testId}
          disabled={disabled}
          rows={3}
          placeholder="one per line"
          value={Array.isArray(value) ? value.join("\n") : ""}
          onChange={(event) => {
            const lines = event.target.value
              .split("\n")
              .map((line) => line.trim())
              .filter((line) => line !== "");
            onChange(lines.length === 0 ? undefined : lines);
          }}
        />
      );
    case "choices": {
      const chosen = new Set(Array.isArray(value) ? (value as string[]) : []);
      return (
        <fieldset
          className="policy-choices"
          data-testid={testId}
        >
          <legend className="visually-hidden">{label}</legend>
          {control.values.map((choice) => (
            <Checkbox
              key={choice}
              label={choice}
              disabled={disabled}
              checked={chosen.has(choice)}
              onChange={(checked) => {
                const next = control.values.filter((v) =>
                  v === choice ? checked : chosen.has(v),
                );
                onChange(next.length === 0 ? undefined : next);
              }}
            />
          ))}
        </fieldset>
      );
    }
    case "orFalse": {
      const off = value === false;
      return (
        <div className="policy-or-false">
          <Checkbox
            label="Off"
            data-testid={testId === undefined ? undefined : `${testId}-off`}
            disabled={disabled}
            checked={off}
            onChange={(checked) => onChange(checked ? false : undefined)}
          />
          {off || control.inner.kind === "object" ? null : (
            <FieldControl
              control={control.inner}
              value={value}
              onChange={onChange}
              disabled={disabled}
              label={label}
              {...(testId === undefined ? {} : { testId })}
            />
          )}
        </div>
      );
    }
    default:
      return (
        <JsonControl
          value={value}
          onChange={onChange}
          disabled={disabled}
          label={label}
          {...(testId === undefined ? {} : { testId })}
        />
      );
  }
}
