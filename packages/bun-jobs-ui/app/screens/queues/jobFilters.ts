import type { JobState } from "../../api/contract";
import type { JobListFilters } from "../../api/queues";
import { clampLimit, intParam, splitList } from "./urlState";

/** The state tab that lists every state. */
export const ALL_STATES = "all";

/** A state tab's value. */
export type StateTab = JobState | typeof ALL_STATES;

/** Longest failure message shown in a row; the whole one is its tooltip. */
export const FAILURE_PREVIEW_CHARS = 80;

/** Shortens text to `max` characters with an ellipsis. */
export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Reads the jobs-list filters from the URL, clamped to the API's limits. */
export function readJobFilters(
  params: URLSearchParams,
  tab: StateTab,
  limits: { defaultPageSize: number; maxPageSize: number },
): JobListFilters {
  return {
    state: tab === ALL_STATES ? null : tab,
    offset: intParam(params, "offset", 0),
    limit: clampLimit(
      intParam(params, "limit", limits.defaultPageSize),
      limits.maxPageSize,
    ),
    // Newest first by default: the most recent job is what a person looks
    // for. Only the exception, `order=asc`, is written into the URL.
    //
    // **Do not drop this override for the API's own default (`asc`).** Paging
    // a list that changes under you loses rows either way, but measured over
    // 822 trials the two directions differ in whether anyone can tell: in
    // `desc` every miss leaves a repeated id, while in `asc` against a
    // draining queue every miss was silent — 100% of the trials that missed,
    // on every backend. So this line keeps a reader on the direction whose
    // losses are at least visible, until the jobs list pages by cursor.
    order: params.get("order") === "asc" ? "asc" : "desc",
    names: splitList(params.get("name") ?? ""),
    search: params.get("search") ?? "",
    total: params.get("total") === "1",
  };
}
