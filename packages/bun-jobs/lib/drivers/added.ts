import type {
  AddedRange,
  JobQuery,
  JobRecord,
  JobState,
  QueueDriver,
} from "./driver";
import { compareCodePoints } from "../shared/strings";

/**
 * Reading jobs by when they were added: the per-state counts of the jobs
 * created in a range ({@link QueueDriver.countAddedJobs}) and the job list's
 * `sort: "createdAt"` ({@link JobQuery.sort}) — defined once, here, so no
 * backend reinvents them.
 *
 * The attribution precedent: `driver.ts` names the method and the field, this
 * module says exactly what they mean, and every driver (and the scan fallback
 * in `readApis.ts`) matches through it or reproduces it in its own query
 * language. The shared driver contract compares each backend against
 * {@link countAddedByScan} and {@link compareCreated} applied to that backend's
 * own records.
 *
 * The rules, in one place:
 *
 * - **`from` is inclusive and `to` exclusive**, over `createdAt`
 *   ({@link inAddedRange}); `to <= from` matches nothing
 *   ({@link rangeMatchesNothing}).
 * - **Counts cover only jobs still stored**, in the state each is in now, and
 *   every state is present, zero when empty ({@link emptyAddedCounts}).
 * - **`"createdAt"` orders by `createdAt`, then by `id` by code point**
 *   ({@link compareCreated}); `desc` reverses both.
 * - **One method stands for both.** A driver implementing `countAddedJobs`
 *   promises to honour the sort ({@link supportsCreatedSort}).
 */

/** Whether `createdAt` lies in the range: `[range.from, range.to)`. */
export function inAddedRange(range: AddedRange, createdAt: number): boolean {
  return createdAt >= range.from && createdAt < range.to;
}

/**
 * Whether no job can be in the range, whatever is stored: `to` not after
 * `from`. A driver answers `{}` without reading anything.
 */
export function rangeMatchesNothing(range: AddedRange): boolean {
  return range.to <= range.from;
}

/** A count of zero for every state: the record a queue's counts start from. */
export function emptyAddedCounts(): Record<JobState, number> {
  return {
    waiting: 0,
    delayed: 0,
    active: 0,
    completed: 0,
    failed: 0,
    dead: 0,
    "waiting-children": 0,
  };
}

/**
 * How many of `records` were added in the range, by the state each is in:
 * the one definition every backend's `countAddedJobs` is compared against.
 * Every state is present. Pass `into` to add to counts already started.
 */
export function countAddedByScan(
  records: Iterable<Pick<JobRecord, "state" | "createdAt">>,
  range: AddedRange,
  into: Record<JobState, number> = emptyAddedCounts(),
): Record<JobState, number> {
  if (rangeMatchesNothing(range)) {
    return into;
  }

  for (const record of records) {
    if (inAddedRange(range, record.createdAt)) {
      into[record.state] += 1;
    }
  }

  return into;
}

/**
 * The `"createdAt"` order: by `createdAt`, and jobs created in the same
 * millisecond by `id`, by code point. Ascending; negate it (or reverse the
 * sorted list) for `desc`, which reverses both keys. Total over distinct ids,
 * so a sort by it is the same sequence on every backend and every run.
 */
export function compareCreated(
  a: Pick<JobRecord, "createdAt" | "id">,
  b: Pick<JobRecord, "createdAt" | "id">,
): number {
  return a.createdAt - b.createdAt || compareCodePoints(a.id, b.id);
}

/**
 * `records` sorted in place by {@link compareCreated}, reversed for `desc`,
 * and answered for chaining.
 */
export function sortByCreated<T extends Pick<JobRecord, "createdAt" | "id">>(
  records: T[],
  order: "asc" | "desc",
): T[] {
  return order === "desc"
    ? records.sort((a, b) => compareCreated(b, a))
    : records.sort(compareCreated);
}

/** Whether a query asks for the `"createdAt"` order rather than the natural one. */
export function sortsByCreated(query: Pick<JobQuery, "sort">): boolean {
  return query.sort === "createdAt";
}

/**
 * Whether a driver serves reads by `createdAt`: it implements
 * {@link QueueDriver.countAddedJobs}, which is its promise to honour
 * `sort: "createdAt"` in `findJobs` too. The runtime twin of the API's
 * `features.addedByState` (before the API's own rule that the routes are
 * served).
 */
export function supportsCreatedSort(
  driver: Pick<QueueDriver, "countAddedJobs">,
): boolean {
  return typeof driver.countAddedJobs === "function";
}
