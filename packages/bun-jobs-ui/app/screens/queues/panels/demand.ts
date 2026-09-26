import type { QueueDemandDto } from "../../../api/types";
import { formatNumber } from "../../../format";

/**
 * How a demand reading is written, so the UI never states a lower bound or
 * an approximation as a precise count.
 *
 * - **`capped`**: some count reached the backend's count cap, and the API says
 *   only that "the figures are lower bounds", not which one. So every count
 *   reads "at least" (`≥`) — the workers and the paused flag are not counts
 *   of jobs and are exempt.
 * - **`exact: false`**: the backend cannot count demand directly and the
 *   figures come from a fallback that is right as a trigger, approximate as a
 *   count. It touches `dueNow` (only `1` or `0`), `stalled` (all of `active`
 *   when no worker is live) and `nextDueAt`, and through them `demand` and
 *   `outstanding`; `waiting` and `active` are still counted, so they are not
 *   marked.
 */

/** A count of a demand reading. */
export type DemandFigure =
  | "demand"
  | "outstanding"
  | "waiting"
  | "dueNow"
  | "stalled"
  | "active";

/** The figures the fallback of a backend that cannot count demand approximates. */
const APPROXIMATE: ReadonlySet<DemandFigure> = new Set<DemandFigure>([
  "demand",
  "outstanding",
  "dueNow",
  "stalled",
]);

/** How one figure of a reading is qualified: a lower bound, approximate, or neither. */
export interface DemandQualifier {
  /** A count cap was reached: the figure is at least this. */
  atLeast: boolean;
  /** The backend's fallback produced it: right as a trigger, approximate as a count. */
  approximate: boolean;
}

/** How `figure` of `reading` is qualified. */
export function qualify(
  reading: Pick<QueueDemandDto, "capped" | "exact">,
  figure: DemandFigure,
): DemandQualifier {
  return {
    atLeast: reading.capped,
    approximate: !reading.exact && APPROXIMATE.has(figure),
  };
}

/**
 * `figure` of `reading` as text: the number, prefixed `≥` when it is a lower
 * bound and `≈` when it is approximate (`≥` wins: a lower bound is the
 * stronger thing to know).
 */
export function formatDemandFigure(
  reading: QueueDemandDto,
  figure: DemandFigure,
): string {
  const { atLeast, approximate } = qualify(reading, figure);
  const value = formatNumber(reading[figure]);
  return atLeast ? `≥${value}` : approximate ? `≈${value}` : value;
}

/** The tooltip of a qualified figure, or `undefined` for a plain one. */
export function demandFigureHint(
  reading: QueueDemandDto,
  figure: DemandFigure,
): string | undefined {
  const { atLeast, approximate } = qualify(reading, figure);
  const parts = [
    atLeast &&
      "At least this many: a count reached the backend's cap, so the figures are lower bounds.",
    approximate &&
      "Approximate: this backend cannot count demand directly, so the figure is right as a trigger but not as a count.",
  ].filter((part): part is string => part !== false);
  return parts.length === 0 ? undefined : parts.join(" ");
}

/** What each figure means, for the panel's labels and hints. */
export const DEMAND_FIGURES: readonly {
  /** The figure. */
  figure: DemandFigure;
  /** Its label. */
  label: string;
  /** What it counts. */
  hint: string;
}[] = [
  {
    figure: "demand",
    label: "Demand",
    hint: "Work a worker could claim now: waiting, due now and stalled. 0 while the queue is paused. Point a launch-style scaler (a KEDA ScaledJob, an ACA event job) here.",
  },
  {
    figure: "outstanding",
    label: "Outstanding",
    hint: "Every unfinished job, each once: demand plus the jobs being worked on. It stays above 0 while a worker is busy on a long job. 0 while paused. Point a scale-style scaler (a KEDA ScaledObject) here.",
  },
  {
    figure: "waiting",
    label: "Waiting",
    hint: "Jobs in waiting.",
  },
  {
    figure: "dueNow",
    label: "Due now",
    hint: "Delayed jobs and pending retries whose time has passed, not yet promoted to waiting.",
  },
  {
    figure: "stalled",
    label: "Stalled",
    hint: "Active jobs whose worker died holding them: what the stalled sweep would recover now.",
  },
  {
    figure: "active",
    label: "Active",
    hint: "Jobs being worked on, stalled ones included.",
  },
];
