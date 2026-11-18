/**
 * What the kit's charts share (PR-U2): series tones, which the stylesheet
 * maps to the `--chart-*` colour aliases (tokens.css, held to 3:1 against
 * the surface in both schemes), and the number and time formats the
 * summaries and tables use. No inline style anywhere (the shell's CSP is
 * `style-src 'self'`): geometry is SVG attributes, colour is a class.
 */

/** A series' colour, by meaning. */
export type ChartTone =
  "allow" | "block" | "challenge" | "delay" | "dryrun" | "log" | "other";

/** Every tone, for a legend's order and the tests. */
export const CHART_TONES: readonly ChartTone[] = Object.freeze([
  "allow",
  "block",
  "challenge",
  "delay",
  "dryrun",
  "log",
  "other",
]);

/** A series of a chart. */
export interface ChartSeries {
  /** Its key in each point's values. */
  readonly key: string;
  /** How it reads in the legend and the table. */
  readonly label: string;
  /** Its colour. */
  readonly tone: ChartTone;
}

/** A count as it reads: `1,234`. */
export function formatCount(value: number): string {
  return Math.round(value).toLocaleString();
}

/** A share as it reads: `12.5%`. */
export function formatShare(value: number): string {
  return `${(value * 100).toFixed(value >= 0.1 || value === 0 ? 0 : 1)}%`;
}

/** An instant as a chart's table reads it. */
export function formatTime(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  });
}

/** The step (0 to 4) of `value` against `max`: 0 only for nothing. */
export function heatStep(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((value / max) * 4)));
}
