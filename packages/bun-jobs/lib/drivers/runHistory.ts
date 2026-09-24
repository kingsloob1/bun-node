import type { RunnerDriver, RunRecord } from "./driver";

/**
 * Paging over a runner's run history.
 *
 * The history is a bounded list — `keepHistory` records, newest first — that
 * every driver holds whole in one place: an array on the memory driver, one
 * JSON document on the file, SQL and MongoDB drivers, one list on Redis. That
 * is why a page carries an exact {@link RunHistoryPage.total} rather than the
 * opt-in count the job list offers: counting costs a driver nothing it has not
 * already read.
 */
export interface RunHistoryQuery {
  /** Records skipped before the page. */
  offset: number;
  /** Most records the page may hold. */
  limit: number;
  /**
   * Which end to read from, by start time: `"desc"` (the default everywhere
   * this is built) is newest first, the order the history is stored and the
   * only order it was ever served in before paging existed.
   */
  order: "asc" | "desc";
}

/** A page of a runner's history, with the whole list's size. */
export interface RunHistoryPage {
  /** The page's records, in the order asked for. */
  records: RunRecord[];
  /**
   * How many records the runner's history holds in total — never just this
   * page. Exact, and read from the same snapshot the page came from, so
   * `offset + records.length < total` answers "is there more" without a
   * second read.
   */
  total: number;
}

/**
 * Applies a {@link RunHistoryQuery}'s order and page to records already read.
 *
 * The shared fallback behind {@link RunnerDriver.pageHistory}: a driver that
 * cannot slice in its store reads the history and hands it here, exactly as
 * `pageRunLog` serves a driver that cannot slice a run log.
 */
export function pageRunHistory(
  /** The runner's whole history, newest first, as the store holds it. */
  records: readonly RunRecord[],
  /** What to order and page by. */
  opts: RunHistoryQuery,
): RunHistoryPage {
  // Stored newest first, so `desc` is the stored order and `asc` its reverse.
  const ordered = opts.order === "asc" ? records.toReversed() : records;
  const offset = Math.max(0, Math.floor(opts.offset));
  const limit = Math.max(0, Math.floor(opts.limit));

  return {
    records: ordered
      .slice(offset, offset + limit)
      .map((entry) => ({ ...entry })),
    total: records.length,
  };
}

/**
 * Reads a page of a runner's history from whichever driver it has.
 *
 * Uses {@link RunnerDriver.pageHistory} where the driver implements it, and
 * otherwise reads the whole history — bounded by `keepHistory` — and slices it
 * here. The fallback is correct rather than merely tolerable: one
 * `listHistory` call is one snapshot, so the page and its total still agree.
 */
export async function readHistoryPage(
  /** The driver holding the history. */
  driver: Pick<RunnerDriver, "listHistory" | "pageHistory">,
  /** The namespace the runner lives in. */
  ns: string,
  /** The runner's storage key. */
  key: string,
  /** What to order and page by. */
  opts: RunHistoryQuery,
): Promise<RunHistoryPage> {
  if (driver.pageHistory) {
    return await driver.pageHistory(ns, key, opts);
  }

  return pageRunHistory(await driver.listHistory(ns, key), opts);
}
