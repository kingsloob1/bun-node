/**
 * A heat strip (PR-U2): one cell per bucket, its shade one of five steps of
 * the bucket's value against the largest, for the ban timeline.
 */
import type { ChartTone } from "./chart";
import { heatStep } from "./chart";

/** Props of {@link HeatStrip}. */
export interface HeatStripProps {
  /** Each bucket's value, oldest first. */
  values: readonly number[];
  /** The colour the shades are of. */
  tone: ChartTone;
  /** The viewBox's width. Default 640. */
  width?: number;
}

/** See the module's description. */
export function HeatStrip({ values, tone, width = 640 }: HeatStripProps) {
  const max = Math.max(0, ...values);
  const cell = values.length === 0 ? 0 : width / values.length;
  return (
    <svg
      className="chart-svg heat-strip"
      viewBox={`0 0 ${width} 16`}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      {values.map((value, index) => (
        <rect
          key={index}
          className={`heat-cell heat-${heatStep(value, max)} chart-tone-${tone}`}
          x={index * cell}
          y={0}
          width={Math.max(cell - 1, 0.5)}
          height={16}
        />
      ))}
    </svg>
  );
}
