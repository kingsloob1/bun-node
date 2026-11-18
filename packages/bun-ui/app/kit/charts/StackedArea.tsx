/**
 * Series stacked over time (PR-U2), drawn in SVG: each point's values add
 * up, bottom to top in series order. A dashed `overlay` series (a dry run's
 * would-block) is drawn as a line on top, not stacked.
 */
import type { ChartSeries } from "./chart";

/** One point: its time and each series' value. */
export interface StackedPoint {
  /** The bucket's start, epoch ms. */
  readonly at: number;
  /** Each series' value, by key (absent: 0). */
  readonly values: Readonly<Record<string, number>>;
}

/** Props of {@link StackedArea}. */
export interface StackedAreaProps {
  /** The stacked series, bottom first. */
  series: readonly ChartSeries[];
  /** The points, oldest first. */
  points: readonly StackedPoint[];
  /** A series drawn as a dashed line over the stack. */
  overlay?: ChartSeries;
  /** The viewBox's width. Default 640. */
  width?: number;
  /** The viewBox's height. Default 180. */
  height?: number;
}

/** The padding inside the viewBox. */
const PAD = 4;

/** See the module's description. */
export function StackedArea({
  series,
  points,
  overlay,
  width = 640,
  height = 180,
}: StackedAreaProps) {
  const totals = points.map((point) =>
    series.reduce((sum, item) => sum + (point.values[item.key] ?? 0), 0),
  );
  const overlayValues = overlay
    ? points.map((point) => point.values[overlay.key] ?? 0)
    : [];
  const max = Math.max(1, ...totals, ...overlayValues);
  const innerW = width - PAD * 2;
  const innerH = height - PAD * 2;
  const x = (index: number) =>
    PAD +
    (points.length > 1 ? (index * innerW) / (points.length - 1) : innerW / 2);
  const y = (value: number) => PAD + innerH - (value / max) * innerH;
  const below = points.map(() => 0);
  const layers = series.map((item) => {
    const lower = [...below];
    const upper = points.map((point, index) => {
      below[index] = (below[index] ?? 0) + (point.values[item.key] ?? 0);
      return below[index]!;
    });
    const top = upper.map(
      (value, index) => `${x(index).toFixed(1)},${y(value).toFixed(1)}`,
    );
    const bottom = lower
      .map((value, index) => `${x(index).toFixed(1)},${y(value).toFixed(1)}`)
      .reverse();
    return { item, points: [...top, ...bottom].join(" ") };
  });
  return (
    <svg
      className="chart-svg"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <line
        className="chart-axis"
        x1={PAD}
        x2={width - PAD}
        y1={height - PAD}
        y2={height - PAD}
      />
      {layers.map(({ item, points: shape }) => (
        <polygon
          key={item.key}
          className={`chart-area chart-tone-${item.tone}`}
          points={shape}
        />
      ))}
      {overlay ? (
        <polyline
          className={`chart-overlay chart-tone-${overlay.tone}`}
          points={overlayValues
            .map(
              (value, index) => `${x(index).toFixed(1)},${y(value).toFixed(1)}`,
            )
            .join(" ")}
        />
      ) : null}
    </svg>
  );
}
