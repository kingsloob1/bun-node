import type { UseQueryResult } from "@tanstack/react-query";
import type { HistoryWindow } from "../../api/runners";
import type { RunnerHistoryDto, RunRecordDto } from "../../api/types";
import type { PageWindow } from "../../components/pagerState";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { getRunnerHistory, runnerKeys } from "../../api/runners";
import { useApiClient } from "../../context";
import { clampLimit, intParam, useUrlParams } from "../queues/urlState";
import { useHistoryRefetchInterval } from "./live";
import { defaultHistoryLimit, newestFirst } from "./runnerFormat";

/**
 * Reading a page of the run history — **the one seam** between the history
 * table and where its pages come from.
 *
 * `GET /runners/:runner/history` takes a window (`offset`, `limit`, `order`)
 * and reports `page.total`, so the table pages the runner's **whole** stored
 * history rather than a fetched prefix of it: the "Runs shown" select is the
 * page size, and turning a page re-reads with a new offset. `limits.maxHistory`
 * caps a page, never how deep `offset` may read, so every run `keepHistory`
 * holds is reachable.
 *
 * The window lives in the URL (`offset`, beside `history` and `logs`), as the
 * jobs table's and the runners list's do. That is what keeps `?logs=` working:
 * a link made from a Log button carries the page its run is on, since
 * `update()` merges into the query string it was pressed on. A `?logs=` that
 * names a run **not** on the page shown cannot be located — no route gives a
 * run's position, and a page that is not there cannot be computed from rows we
 * do not have — so {@link RunnerHistoryPage.openRunOffPage} says so and the
 * card tells the reader, rather than pretending.
 *
 * The table takes everything it needs from this module's return value and
 * never does the arithmetic itself, so a future cursor-paged route replaces
 * this function alone.
 */

/** Options of {@link useRunnerHistory}. */
export interface RunnerHistoryPageOptions {
  /** The runner's id. */
  runner: string;
  /** The API's largest page (`limits.maxHistory`), which bounds the size select. */
  maxHistory: number;
  /** Whether to read (and poll) the history at all. */
  enabled: boolean;
  /**
   * The run whose log the URL has open (`?logs=`), or `null` — including
   * `null` when the caller may not read run logs, since nothing is open then.
   */
  openRunId: string | null;
}

/** The page of runs on screen, and what its card and pager need. */
export interface RunnerHistoryPage {
  /** The read behind the page; the card renders its pending, error and data states. */
  query: UseQueryResult<RunnerHistoryDto, Error>;
  /** The runs on the page, newest first. */
  rows: RunRecordDto[];
  /** Runs skipped before the page, as the URL asked for them. */
  offset: number;
  /** Runs per page — the "Runs shown" select, clamped to `1…maxHistory`. */
  limit: number;
  /**
   * Every run the runner has stored, from the route's `page.total`, which is
   * always present and exact here. `0` until the first answer arrives.
   */
  total: number;
  /** Whether the history outgrows one page, and so deserves a pager. */
  paged: boolean;
  /**
   * Whether a new page is being read to replace the one on screen. The pager
   * is disabled while it is true, so one click is one page.
   */
  turning: boolean;
  /**
   * Whether `openRunId` names a run that is not on this page. The card says so
   * rather than silently opening nothing; `false` while the page is empty or
   * still loading, when there is nothing yet to be missing from.
   */
  openRunOffPage: boolean;
  /** Takes the window the `Pager` asks for, and writes it to the URL. */
  onChange: (next: PageWindow) => void;
}

/**
 * The page of the runner's history the URL asks for, read from the server:
 * which runner, how large a page may be, whether to read at all, and which
 * run's log the URL has open ({@link RunnerHistoryPageOptions}).
 */
export function useRunnerHistory({
  runner,
  maxHistory,
  enabled,
  openRunId,
}: RunnerHistoryPageOptions): RunnerHistoryPage {
  const api = useApiClient();
  const [params, update] = useUrlParams();
  const fallback = defaultHistoryLimit(maxHistory);
  const limit = clampLimit(intParam(params, "history", fallback), maxHistory);
  // Uncapped on purpose, as the route is: a `keepHistory` far above
  // `maxHistory` is exactly what deep offsets exist to reach.
  const offset = intParam(params, "offset", 0);
  const asked: HistoryWindow = { offset, limit, order: "desc" };
  const refetchInterval = useHistoryRefetchInterval();
  const query = useQuery({
    queryKey: runnerKeys.history(runner, asked),
    queryFn: ({ signal }) => getRunnerHistory(api, runner, asked, signal),
    refetchInterval,
    enabled,
    // Turning a page swaps the rows in place instead of dropping the table
    // back to its spinner.
    placeholderData: keepPreviousData,
  });
  const rows = query.data ? newestFirst(query.data.items) : [];
  const total = query.data?.page.total ?? 0;
  return {
    query,
    rows,
    offset,
    limit,
    total,
    paged: total > limit,
    turning: query.isFetching && query.isPlaceholderData,
    openRunOffPage:
      openRunId !== null &&
      rows.length > 0 &&
      !rows.some((run) => run.runId === openRunId),
    onChange: (next) => {
      // A new page size restarts paging: offsets of the old size name
      // different runs, and "page 3 of 25" is not "page 3 of 10". Doing it
      // here is what keeps the card's "Runs shown" select and the pager's own
      // "Rows per page" — two views of one value — behaving identically.
      const moved = next.limit === limit ? next.offset : 0;
      update({
        offset: moved > 0 ? String(moved) : null,
        // The default is spelled by leaving the parameter out, as the rest of
        // the screen's parameters are.
        history: next.limit === fallback ? null : String(next.limit),
      });
    },
  };
}
