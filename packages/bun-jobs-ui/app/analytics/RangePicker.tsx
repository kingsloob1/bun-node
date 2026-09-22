import type { RangePreset, TimeRange } from "./range";
import { useState } from "react";
import { Button } from "../components/Button";
import { Field } from "../components/Field";
import { DateTimeInput, Select } from "../components/inputs";
import { useFieldProblems } from "../hooks/useFieldProblems";
import {
  MAX_RANGE_MS,
  PRESET_LABELS,
  RANGE_PRESETS,
  rangeBounds,
  rangeProblem,
} from "./range";
import "./analytics.css";

/** The `<select>` value standing for the custom range, which no preset uses. */
const CUSTOM = "custom";

/** Props of {@link RangePicker}. */
export interface RangePickerProps {
  /** The range in force. */
  range: TimeRange;
  /** Called with the range the user chose. */
  onChange: (range: TimeRange) => void;
  /** An accessible name, e.g. "Jobs range"; several pickers may share a page. */
  label: string;
  /**
   * The longest span this API can serve (`meta.analytics.maxSpanMs`).
   * Presets beyond it are not offered and a custom range beyond it is
   * refused. Defaults to {@link MAX_RANGE_MS}. `null` sets no longest span:
   * every preset is offered and a custom range may be any length (a job
   * list's `finishedOn` window, which the API does not bound).
   */
  maxSpan?: number | null;
}

/**
 * Picks the range an analytics view is read over: a rolling preset, or a
 * custom span between two instants.
 *
 * Choosing a preset applies at once. The custom fields apply on "Apply", so a
 * half-typed start never triggers a read; they open on the instants the
 * current range covers, so switching to custom keeps what is on screen rather
 * than emptying the chart.
 */
export function RangePicker({
  range,
  onChange,
  label,
  maxSpan = MAX_RANGE_MS,
}: RangePickerProps) {
  const bounds = rangeBounds(range);
  const [custom, setCustom] = useState<{
    from: number | undefined;
    to: number | undefined;
  }>(() => ({ from: bounds.from, to: bounds.to }));
  const [showCustom, setShowCustom] = useState(range.kind === "custom");
  const problems = useFieldProblems<"from" | "to">();

  const invalid =
    custom.from === undefined || custom.to === undefined
      ? "Give both a start and an end."
      : rangeProblem(custom.from, custom.to, maxSpan);

  return (
    <div
      className="range-picker"
      role="group"
      aria-label={label}
    >
      <Field label="Range">
        <Select
          value={
            showCustom
              ? CUSTOM
              : String(range.kind === "preset" ? range.seconds : CUSTOM)
          }
          onChange={(value) => {
            if (value === CUSTOM) {
              // Open on what is on screen now, so the chart does not empty.
              const now = rangeBounds(range);
              setCustom({ from: now.from, to: now.to });
              setShowCustom(true);
              return;
            }
            setShowCustom(false);
            onChange({
              kind: "preset",
              seconds: Number(value) as RangePreset,
            });
          }}
          options={[
            // A preset longer than this API keeps is not offered: it would
            // only ever come back clamped.
            ...RANGE_PRESETS.filter(
              (seconds) => maxSpan === null || seconds * 1_000 <= maxSpan,
            ).map((seconds) => ({
              value: String(seconds),
              label: PRESET_LABELS[seconds],
            })),
            { value: CUSTOM, label: "Custom range…" },
          ]}
        />
      </Field>
      {showCustom && (
        <>
          <Field
            label="From"
            error={problems.problems.from}
          >
            <DateTimeInput
              value={custom.from}
              withSeconds
              max={custom.to}
              onChange={(from) =>
                setCustom((current) => ({ ...current, from }))
              }
              onProblem={(problem) => problems.report("from", problem)}
            />
          </Field>
          <Field
            label="To"
            error={problems.problems.to}
            hint={invalid === null || problems.blocked ? undefined : invalid}
          >
            <DateTimeInput
              value={custom.to}
              withSeconds
              min={custom.from}
              max={
                custom.from === undefined || maxSpan === null
                  ? undefined
                  : custom.from + maxSpan
              }
              onChange={(to) => setCustom((current) => ({ ...current, to }))}
              onProblem={(problem) => problems.report("to", problem)}
            />
          </Field>
          <Button
            variant="primary"
            disabled={invalid !== null || problems.blocked}
            onClick={() => {
              if (custom.from !== undefined && custom.to !== undefined) {
                onChange({ kind: "custom", from: custom.from, to: custom.to });
              }
            }}
          >
            Apply
          </Button>
        </>
      )}
    </div>
  );
}
