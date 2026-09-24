import type { RunRecordDto } from "../../api/types";
import type { ClientPage } from "../../components/useClientPage";
import { useClientPage } from "../../components/useClientPage";

/**
 * Paging the run history — **the one seam** between the history table and
 * where its pages come from.
 *
 * `GET /runners/:runner/history` takes a `limit` and no window, so it answers
 * with at most `limits.maxHistory` runs and the table pages what came back:
 * the "Runs shown" select is the fetch, this is the page within it. Nothing is
 * re-read to turn a page.
 *
 * bun-jobs has been asked for a server window, and it may land as a **cursor**
 * rather than an offset (a run finishing between two reads shifts an offset
 * window and repeats a row, which a live history does constantly), possibly
 * reporting `hasMore` instead of a total. So the table takes everything it
 * needs from this module's return value and never does the arithmetic itself:
 * a server cursor replaces this function, and `RunnerHistory.tsx` is untouched
 * beyond dropping the "within the runs fetched" note. `total` is filled in
 * here because paging in the browser genuinely knows it — a server page may
 * leave it `null`, which `Pager` already handles through `hasMore`.
 */

/** Runs per page in the history table. */
export const HISTORY_PAGE_SIZE = 25;

/**
 * The page of runs on screen, and what its pager needs.
 *
 * @param runs Every run fetched, in the order the table lists them (newest
 * first).
 * @param openRunId The run whose log the URL has open (`?logs=`), or `null`.
 * Its page wins over the page the reader turned to, so a `?logs=` link still
 * opens the row it names however far down the history it is.
 */
export function useHistoryPage(
  runs: readonly RunRecordDto[],
  openRunId: string | null,
): ClientPage<RunRecordDto> {
  const pinned =
    openRunId === null ? -1 : runs.findIndex((run) => run.runId === openRunId);
  return useClientPage(runs, HISTORY_PAGE_SIZE, pinned);
}
