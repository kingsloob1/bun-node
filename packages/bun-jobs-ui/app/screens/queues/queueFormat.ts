import type { RepeatableDto } from "../../api/types";
import { formatNumber } from "../../format";
import { formatMs } from "./duration";

/** Most ids listed in a result toast; the rest are summarised. */
export const MAX_LISTED_IDS = 10;

/** Lists ids for a toast, capped at {@link MAX_LISTED_IDS}. */
export function listIds(ids: readonly string[]): string {
  const shown = ids.slice(0, MAX_LISTED_IDS).join(", ");
  const rest = ids.length - MAX_LISTED_IDS;
  return rest > 0 ? `${shown} and ${formatNumber(rest)} more` : shown;
}

/** A series' schedule as text: `cron (tz)` or `every 5m`. */
export function describeSchedule(series: RepeatableDto): string {
  if (series.cron) {
    return series.tz ? `${series.cron} (${series.tz})` : series.cron;
  }
  if (series.every !== undefined) {
    return `every ${formatMs(series.every)}`;
  }
  return "—";
}
