/** Inner padding, so a stroke at the extremes is not clipped. */
export const SPARK_PAD = 2;

/** An SVG polyline `points` string for a series scaled to `max`. */
export function sparkPoints(
  values: readonly number[],
  max: number,
  width: number,
  height: number,
): string {
  if (values.length === 0) {
    return "";
  }
  const innerW = width - SPARK_PAD * 2;
  const innerH = height - SPARK_PAD * 2;
  const step = values.length > 1 ? innerW / (values.length - 1) : 0;
  return values
    .map((value, index) => {
      const x = SPARK_PAD + (values.length > 1 ? index * step : innerW / 2);
      const y = SPARK_PAD + innerH - (max > 0 ? (value / max) * innerH : 0);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}
