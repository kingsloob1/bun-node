import type { RunnerDriver, RunRecord } from "./driver";
import type { CursorPart } from "./pageCursor";
import { decodePageCursor, encodePageCursor } from "./pageCursor";

/**
 * Paging over a runner's run history.
 *
 * The history is a bounded list — `keepHistory` records, newest first — that
 * every driver holds whole in one place: an array on the memory driver, one
 * JSON document on the file, SQL and MongoDB drivers, one list on Redis. That
 * is why a page carries an exact {@link RunHistoryPage.total} rather than the
 * opt-in count the job list offers: counting costs a driver nothing it has not
 * already read.
 *
 * Two ways to read it, and they answer different questions:
 *
 * - **`offset`** counts records from one end. It is how a client jumps to page
 *   N, and it is a *sample*: the history grows at the head and is trimmed at
 *   the tail, so a record that arrives or leaves between two requests shifts
 *   every position under it.
 * - **{@link RunHistoryQuery.after}, a keyset cursor**, seeks past the last
 *   record the previous page returned. It is how a client *walks* the list.
 *   Nothing shifts under it, because it names a record rather than a count.
 *
 * Neither replaces the other, and both stay.
 */
export interface RunHistoryQuery {
  /** Records skipped before the page. Ignored when {@link RunHistoryQuery.after} is set. */
  offset: number;
  /** Most records the page may hold. */
  limit: number;
  /**
   * Which end to read from, by start time: `"desc"` (the default everywhere
   * this is built) is newest first, the order the history is stored and the
   * only order it was ever served in before paging existed.
   */
  order: "asc" | "desc";
  /**
   * Seek position: start the page at the record **after** this one, in the
   * order asked for, instead of counting `offset` records in.
   *
   * The key of the last record the previous page returned — a driver mints it
   * and a client only ever echoes it back, encoded, as
   * {@link encodeHistoryCursor} makes it. When set, `offset` is ignored.
   */
  after?: RunHistoryCursorKey;
}

/**
 * Where a history walk stopped: the ordering key of the last record a page
 * returned.
 *
 * A **value, not a position**, and that is the whole point — the seek compares
 * keys and never needs the record to still be there, so a walk survives the
 * record it is anchored on being trimmed by `keepHistory` or removed by
 * `DELETE /runners/{runner}/history`.
 *
 * `runId` is what makes it a total order: the history's declared order is by
 * start time, and two runs of a parallel runner can start in the same
 * millisecond.
 */
export interface RunHistoryCursorKey {
  /** {@link RunRecord.startedAt} of the last record the page returned. */
  startedAt: number;
  /** {@link RunRecord.runId} of the last record the page returned. */
  runId: string;
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
  /**
   * Where the page's first record sits in the ordered history: `query.offset`
   * on an offset read, and the position the seek resolved to on a cursor read.
   *
   * **A driver that honours {@link RunHistoryQuery.after} must return this**,
   * and one that cannot must leave it out. It is how {@link readHistoryPage}
   * tells the two apart: a driver written before cursors existed would
   * otherwise answer a cursor request with page one, which reads exactly like
   * the end of a list. Absent on a cursor request, the page is discarded and
   * the history read whole and seeked here instead.
   */
  offset?: number;
}

/** What every run-history cursor starts with, and its format version. */
export const HISTORY_CURSOR_PREFIX = "rh1.";

/** Which listing a run-history cursor belongs to. */
const HISTORY_CURSOR_KIND = "runHistory";

/** Everything that decides what a history walk visits, and in what order. */
export interface RunHistoryWalk {
  /** The namespace the runner lives in. */
  ns: string;
  /** The runner, as the request named it. */
  runner: string;
  /** The order being walked; a cursor minted the other way is refused. */
  order: "asc" | "desc";
}

/** A walk's binding as the cursor codec stores it. */
function walkParts(walk: RunHistoryWalk): CursorPart[] {
  return [walk.ns, walk.runner, walk.order];
}

/**
 * Mints the opaque `page.next` for a history page: a cursor resuming `walk`
 * after `key`.
 *
 * Bound to the runner *and* the order, so a cursor replayed against another
 * runner, or the same runner after the order was flipped, is refused rather
 * than resumed from a position that means nothing there.
 */
export function encodeHistoryCursor(
  /** Which walk the cursor continues. */
  walk: RunHistoryWalk,
  /** The last record the page returned. */
  key: RunHistoryCursorKey,
): string {
  return encodePageCursor(
    HISTORY_CURSOR_PREFIX,
    HISTORY_CURSOR_KIND,
    walkParts(walk),
    [key.startedAt, key.runId],
  );
}

/**
 * The seek key inside a cursor from {@link encodeHistoryCursor}, or a
 * `ConfigError` — answered `400 INVALID_ARGUMENT` — when it is not one of this
 * route's cursors or belongs to another walk.
 */
export function decodeHistoryCursor(
  /** The cursor as the client sent it. */
  cursor: string,
  /** The walk being asked for. */
  walk: RunHistoryWalk,
): RunHistoryCursorKey {
  const [startedAt, runId] = decodePageCursor(
    cursor,
    HISTORY_CURSOR_PREFIX,
    HISTORY_CURSOR_KIND,
    walkParts(walk),
    ["number", "string"],
  );

  return { startedAt: startedAt as number, runId: runId as string };
}

/**
 * Whether `record` sorts strictly after `key` in the direction `order` walks.
 *
 * By `(startedAt, runId)`: the history's declared order is by start time, and
 * `runId` breaks the ties two runs starting in the same millisecond leave.
 */
function isAfter(
  /** The record being considered for the page. */
  record: RunRecord,
  /** Where the previous page stopped. */
  key: RunHistoryCursorKey,
  /** The direction being walked. */
  order: "asc" | "desc",
): boolean {
  const sign = order === "asc" ? 1 : -1;

  if (record.startedAt !== key.startedAt) {
    return (record.startedAt - key.startedAt) * sign > 0;
  }
  if (record.runId === key.runId) {
    return false;
  }

  return (record.runId > key.runId ? 1 : -1) * sign > 0;
}

/**
 * Where a page seeking past `key` starts, in a history already put in the
 * order being walked.
 *
 * Two steps, and the second is what makes the cursor a value rather than a
 * position:
 *
 * 1. **The record is still there** — resume immediately after it, by index.
 *    Exact whatever the keys do, so two runs sharing a millisecond, or a
 *    history whose stored order is not quite its `startedAt` order, can
 *    neither repeat nor skip a row.
 * 2. **It is gone** — trimmed by `keepHistory`, or removed by a history clear
 *    — so fall back to the key itself and resume at the first record sorting
 *    strictly after it. `asc` then loses nothing: the trim drops the oldest,
 *    which in `asc` is *behind* the cursor, so the first surviving record is
 *    exactly the next one. `desc` walks toward the old end, so a trim takes
 *    records the walk had not reached yet and this ends the walk —
 *    irreducible, since no scheme can show a record that no longer exists.
 */
function seekIndex(
  /** The history in the order being walked. */
  ordered: readonly RunRecord[],
  /** Where the previous page stopped. */
  key: RunHistoryCursorKey,
  /** The direction being walked. */
  order: "asc" | "desc",
): number {
  const anchor = ordered.findIndex((entry) => entry.runId === key.runId);

  if (anchor !== -1) {
    return anchor + 1;
  }

  const next = ordered.findIndex((entry) => isAfter(entry, key, order));

  return next === -1 ? ordered.length : next;
}

/**
 * Applies a {@link RunHistoryQuery}'s order and page to records already read.
 *
 * The shared fallback behind {@link RunnerDriver.pageHistory}: a driver that
 * cannot slice in its store reads the history and hands it here, exactly as
 * `pageRunLog` serves a driver that cannot slice a run log. It honours
 * {@link RunHistoryQuery.after}, so a driver that delegates to it serves
 * cursors for free.
 */
export function pageRunHistory(
  /** The runner's whole history, newest first, as the store holds it. */
  records: readonly RunRecord[],
  /** What to order and page by. */
  opts: RunHistoryQuery,
): RunHistoryPage {
  // Stored newest first, so `desc` is the stored order and `asc` its reverse.
  const ordered = opts.order === "asc" ? records.toReversed() : records;
  const limit = Math.max(0, Math.floor(opts.limit));
  const offset =
    opts.after === undefined
      ? Math.max(0, Math.floor(opts.offset))
      : seekIndex(ordered, opts.after, opts.order);

  return {
    records: ordered
      .slice(offset, offset + limit)
      .map((entry) => ({ ...entry })),
    total: records.length,
    offset,
  };
}

/**
 * Reads a page of a runner's history from whichever driver it has.
 *
 * Uses {@link RunnerDriver.pageHistory} where the driver implements it, and
 * otherwise reads the whole history — bounded by `keepHistory` — and slices it
 * here. The fallback is correct rather than merely tolerable: one
 * `listHistory` call is one snapshot, so the page and its total still agree.
 *
 * The same fallback covers a driver whose `pageHistory` predates the cursor:
 * asked to seek and answering without a resolved
 * {@link RunHistoryPage.offset}, its page is discarded and the history is read
 * whole instead. Correctness over a round trip, and only on a cursor request —
 * an absent `offset` on an offset request is just `query.offset`.
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
    const page = await driver.pageHistory(ns, key, opts);

    if (page.offset !== undefined) {
      return page;
    }
    if (opts.after === undefined) {
      return { ...page, offset: Math.max(0, Math.floor(opts.offset)) };
    }
  }

  return pageRunHistory(await driver.listHistory(ns, key), opts);
}
