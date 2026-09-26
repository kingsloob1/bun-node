import type { WorkerSummonProvenanceDto } from "../../api/types";
import { displayText } from "../../format";

/**
 * How a worker's `summon` reads: which summon attempt started it, and what
 * the summoner asked of it.
 *
 * Three rules from the contract shape every function below:
 *
 * - **Absent says nothing.** A worker with no `summon` was not summoned, or
 *   is too old to say which, so it gets no badge and no row — never a
 *   "not summoned" claim the record does not make.
 * - **`mode` and `deadlineAt` are what the summoner requested**, not what the
 *   worker is doing: they are always labelled "requested", and a missing one
 *   is left out rather than defaulted.
 * - **A mode this build does not know is shown as its raw string**, since a
 *   later server may add one. The labels are an exhaustive record of the
 *   modes the contract lists, so a mode added there is a compile error here
 *   until it is named.
 */

/** A summon mode the contract lists. */
export type SummonMode = NonNullable<WorkerSummonProvenanceDto["mode"]>;

/** Each known requested mode in plain words, and what it asks. */
const MODE_TEXT: Readonly<Record<SummonMode, { label: string; hint: string }>> =
  {
    "exit-on-idle": {
      label: "Exit when idle",
      hint: "The summoner asked it to exit once its queue has no work for it.",
    },
    "until-stopped": {
      label: "Run until stopped",
      hint: "The summoner asked it to keep running until something stops it.",
    },
    "in-invocation": {
      label: "Within one invocation",
      hint: "The summoner asked it to run inside a single platform invocation, and end with it.",
    },
  };

/** Said of every summon: it is how the worker was started, not a setting. */
export const SUMMON_NOTE =
  "How this worker was started, as its summoner recorded it. The mode and deadline are what the summoner requested, not a report of what the worker is doing.";

/** Whether `mode` is one this build names (an own key, so `"toString"` is not). */
function isKnownMode(mode: unknown): mode is SummonMode {
  return typeof mode === "string" && Object.hasOwn(MODE_TEXT, mode);
}

/** A requested mode in plain words, or the raw string for a mode this build does not know. */
export function summonModeLabel(mode: SummonMode): string {
  return isKnownMode(mode) ? MODE_TEXT[mode].label : displayText(mode);
}

/** What a requested mode asks, in a sentence; for a mode this build does not know, says so. */
export function summonModeHint(mode: SummonMode): string {
  return isKnownMode(mode)
    ? MODE_TEXT[mode].hint
    : `The summoner requested a mode this version of the UI does not know ("${displayText(mode)}").`;
}

/**
 * What a worker table's summon badge reads: "Summoned", and the summoner's
 * kind when it gave one ("Summoned by ecs").
 */
export function summonBadgeLabel(summon: WorkerSummonProvenanceDto): string {
  return summon.kind === undefined
    ? "Summoned"
    : `Summoned by ${displayText(summon.kind)}`;
}

/**
 * The summon badge's tooltip: the attempt, and whatever the summoner
 * requested, each named as a request. A deadline is given as an absolute
 * instant, since a tooltip does not tick.
 */
export function summonHint(summon: WorkerSummonProvenanceDto): string {
  const requested = [
    summon.mode !== undefined &&
      `requested mode: ${summonModeLabel(summon.mode)}`,
    // `toISOString` throws on a value that is not a finite number, and the
    // listing is not shape-checked.
    typeof summon.deadlineAt === "number" &&
      Number.isFinite(summon.deadlineAt) &&
      `requested deadline: ${new Date(summon.deadlineAt).toISOString()}`,
  ].filter((part): part is string => part !== false);
  return [
    `Started by a summoner, attempt ${displayText(summon.id)}.`,
    requested.length > 0 ? `The summoner's ${requested.join("; ")}.` : "",
    "How it was started, not a setting.",
  ]
    .filter((part) => part !== "")
    .join(" ");
}
