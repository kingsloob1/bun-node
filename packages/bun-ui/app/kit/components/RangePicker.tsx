import type { RangeModel, TimeRange } from "../range";
import { useState } from "react";
import { useFieldProblems } from "../hooks/useFieldProblems";
import { rangeBounds } from "../range";
import { Button } from "./Button";
import { Field } from "./Field";
import { DateTimeInput, Select } from "./inputs";

/** The `<select>` value standing for the custom range, which no preset uses. */
const CUSTOM = "custom";

/** Props of {@link RangePicker}. */
export interface RangePickerProps<P extends number = number> {
  /** The UI's range model: its presets, labels and bounds. */
  model: RangeModel<P>;
  /** The range in force. */
  range: TimeRange<P>;
  /** Called with the range the user chose. */
  onChange: (range: TimeRange<P>) => void;
  /** An accessible name, e.g. "Jobs range"; several pickers may share a page. */
  label: string;
  /**
   * The longest span this API can serve (`meta.analytics.maxSpanMs`).
   * Presets beyond it are not offered and a custom range beyond it is
   * refused. Defaults to the model's `maxSpanMs`. `null` sets no longest span:
   * every preset is offered and a custom range may be any length (a job
   * list's `finishedOn` window, which the API does not bound).
   */
  maxSpan?: number | null;
}

/**
 * Picks the range an analytics view is read over (the kit's, moved from the
 * jobs app in PR-U2; each UI passes its range model): a rolling preset, or a
 * custom span between two instants.
 *
 * Choosing a preset applies at once. The custom fields apply on "Apply", so a
 * half-typed start never triggers a read; they open on the instants the
 * current range covers, so switching to custom keeps what is on screen rather
 * than emptying the chart.
 */
export function RangePicker<P extends number>({
  model,
  range,
  onChange,
  label,
  maxSpan = model.maxSpanMs,
}: RangePickerProps<P>) {
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
      : model.rangeProblem(custom.from, custom.to, maxSpan);

  return (
    <div
      className="range-picker"
      role="group"
      aria-label={label}
    >
      <Field label="Range">
        <Select
          alwaysSet
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
              seconds: Number(value) as P,
            });
          }}
          options={[
            // A preset longer than this API keeps is not offered: it would
            // only ever come back clamped.
            ...model.presets
              .filter(
                (seconds) => maxSpan === null || seconds * 1_000 <= maxSpan,
              )
              .map((seconds) => ({
                value: String(seconds),
                label: model.labels[seconds],
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
