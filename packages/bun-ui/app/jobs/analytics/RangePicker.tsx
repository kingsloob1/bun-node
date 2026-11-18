/**
 * The jobs UI's range picker: the kit's (PR-U2), bound to the jobs range
 * model.
 */
import type { RangePickerProps as KitRangePickerProps } from "../../kit/components/RangePicker";
import type { RangePreset } from "./range";
import { RangePicker as KitRangePicker } from "../../kit/components/RangePicker";
import { RANGE_MODEL } from "./range";
import "./analytics.css";

/** Props of {@link RangePicker}: the kit's, without the model. */
export type RangePickerProps = Omit<KitRangePickerProps<RangePreset>, "model">;

/** The kit's picker over the jobs presets. */
export function RangePicker(props: RangePickerProps) {
  return (
    <KitRangePicker
      model={RANGE_MODEL}
      {...props}
    />
  );
}
