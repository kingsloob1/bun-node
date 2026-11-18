/**
 * Horizontal bars (PR-U2): one row per item, its label and value as text
 * beside an SVG bar scaled to the largest (so it reads without the bar).
 * A bar may be split into tones (allowed and blocked).
 */
import type { ChartTone } from "./chart";
import { formatCount } from "./chart";

/** One bar. */
export interface BarItem {
  /** Its key. */
  readonly key: string;
  /** Its label. */
  readonly label: string;
  /** Its parts, each a tone and a value; the bar is their sum. */
  readonly parts: readonly {
    readonly tone: ChartTone;
    readonly value: number;
  }[];
  /** The value shown beside it (default the sum). */
  readonly text?: string;
}

/** Props of {@link BarList}. */
export interface BarListProps {
  /** The bars, in order. */
  items: readonly BarItem[];
}

/** The bar's drawn width. */
const WIDTH = 200;

/** See the module's description. */
export function BarList({ items }: BarListProps) {
  const max = Math.max(
    1,
    ...items.map((item) =>
      item.parts.reduce((sum, part) => sum + part.value, 0),
    ),
  );
  return (
    <ul className="bar-list">
      {items.map((item) => {
        const total = item.parts.reduce((sum, part) => sum + part.value, 0);
        let offset = 0;
        return (
          <li key={item.key}>
            <span className="bar-label">{item.label}</span>
            <svg
              className="bar-svg"
              viewBox={`0 0 ${WIDTH} 10`}
              preserveAspectRatio="none"
              aria-hidden="true"
              focusable="false"
            >
              {item.parts.map((part, index) => {
                const width = (part.value / max) * WIDTH;
                const rect = (
                  <rect
                    key={index}
                    className={`chart-bar chart-tone-${part.tone}`}
                    x={offset}
                    y={0}
                    width={width}
                    height={10}
                  />
                );
                offset += width;
                return rect;
              })}
            </svg>
            <span className="bar-value">{item.text ?? formatCount(total)}</span>
          </li>
        );
      })}
    </ul>
  );
}
