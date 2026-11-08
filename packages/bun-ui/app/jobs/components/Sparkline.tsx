import { SPARK_PAD, sparkPoints } from "./sparkPoints";

/** Props of {@link Sparkline}. */
export interface SparklineProps {
  /** The main series, oldest first (e.g. completed per minute). */
  values: readonly number[];
  /** An optional second series on the same scale (e.g. failed per minute). */
  secondary?: readonly number[];
  /** Accessible description of what the line shows. */
  label: string;
  /** Width in CSS pixels. Defaults to `120`. */
  width?: number;
  /** Height in CSS pixels. Defaults to `28`. */
  height?: number;
}

/** A tiny inline line chart; decorative detail, with a text label for assistive tech. */
export function Sparkline({
  values,
  secondary,
  label,
  width = 120,
  height = 28,
}: SparklineProps) {
  const max = Math.max(1, ...values, ...(secondary ?? []));
  return (
    <svg
      className="sparkline"
      role="img"
      aria-label={label}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
    >
      <title>{label}</title>
      <line
        className="sparkline-baseline"
        x1={SPARK_PAD}
        x2={width - SPARK_PAD}
        y1={height - SPARK_PAD}
        y2={height - SPARK_PAD}
      />
      {secondary && secondary.length > 0 && (
        <polyline
          className="sparkline-secondary"
          points={sparkPoints(secondary, max, width, height)}
        />
      )}
      <polyline
        className="sparkline-primary"
        points={sparkPoints(values, max, width, height)}
      />
    </svg>
  );
}
