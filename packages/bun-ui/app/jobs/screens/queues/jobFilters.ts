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

/**
 * Reads the jobs-list filters from the URL, clamped to the API's limits,
 * plus `cursor` where the reader is walking the list rather than jumping
 * about in it.
 *
 * The cursor is the one thing here that is **not** a URL parameter: it is
 * opaque and up to 2 kB, and walking back needs the whole trail of them, so
 * the walk lives in the screen's own state and the URL keeps saying where
 * that walk started.
 */
export function readJobFilters(
  params: URLSearchParams,
  tab: StateTab,
  limits: { defaultPageSize: number; maxPageSize: number },
  cursor?: string,
): JobListFilters {
  return {
    state: tab === ALL_STATES ? null : tab,
    offset: intParam(params, "offset", 0),
    ...(cursor === undefined ? {} : { cursor }),
    limit: clampLimit(
      intParam(params, "limit", limits.defaultPageSize),
      limits.maxPageSize,
    ),
    // Newest first by default: the most recent job is what a person looks
    // for. Only the exception, `order=asc`, is written into the URL.
    //
    // **Do not drop this override for the API's own default (`asc`).**
    // Paging a list that changes under you can lose rows, and the two
    // directions differ in whether anyone can tell. Measured by the offset
    // probe: `desc` lost no rows at all, and a moved window showed up as a
    // repeated row rather than a missing one; `asc` against a draining queue
    // lost rows in more than half its trials, and most of those losses were
    // invisible to the client. Asking for a total made some of them visible
    // and not others, which is why a total is not a safety net — a shifted
    // window can leave every field of the response unchanged. So this line
    // keeps a reader on the direction whose losses leave a trace.
    //
    // The list walks by cursor now, and a walk loses none of that in either
    // direction. It does not retire this line: a reader still *jumps* by
    // offset, every walk starts from an offset page, and the Active tab
    // cannot be walked at all. So the direction whose losses leave a trace is
    // still the one to start on.
    //
    // Deliberately no figures: a count in a comment is a count nothing
    // compares against its source, and the first version of this one carried
    // a trial total that was already wrong when it was written.
    order: params.get("order") === "asc" ? "asc" : "desc",
    names: splitList(params.get("name") ?? ""),
    search: params.get("search") ?? "",
    total: params.get("total") === "1",
  };
}
