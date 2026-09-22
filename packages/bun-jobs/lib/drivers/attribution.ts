import type {
  ClaimOptions,
  DriverCapabilities,
  JobQuery,
  JobRecord,
  JobState,
  JobWorkerRef,
  QueueDriver,
} from "./driver";

/**
 * Job attribution: which worker claimed a job's current or last attempt, and
 * the four filters over it — defined once, here, so no backend reinvents them.
 *
 * The run-log and analytics precedent: the contract in `driver.ts` names the
 * fields, this module says exactly what they mean, and every driver (and the
 * scan fallback in `readApis.ts`) matches through it or reproduces it in its
 * own query language. The shared driver contract compares each backend against
 * {@link matchesAttribution} applied to that backend's own records.
 *
 * The rules, in one place:
 *
 * - **The claim stamps it** ({@link attributionOf}), in the write it already
 *   makes; nothing else writes it and no settle clears it.
 * - **`workerKeys` / `workerIds`** match `processedBy.key` / `processedBy.id`
 *   exactly. A job with no stamp, or a stamp without a key, never matches a
 *   key. An empty list matches nothing.
 * - **`finishedFrom` is inclusive and `finishedTo` exclusive**, over
 *   `finishedOn`. Only `completed` and `dead` jobs can match a range: those
 *   are the states whose natural order *is* `finishedOn` on every backend, so a
 *   driver can serve a range from that order and skip every other state. A job
 *   with no `finishedOn` never matches. `finishedTo <= finishedFrom` matches
 *   nothing.
 * - The filters AND with each other and with `states`, `names` and `search`.
 */

/** The states a `finishedOn` range can match: the ones ordered by it. */
export const FINISHED_STATES: readonly JobState[] = ["completed", "dead"];

/**
 * The stamp a claim writes as `processedBy`: the worker's id, plus its key,
 * host and pid when the claimer gave them. Always a fresh object, so a driver
 * may store it as is.
 */
export function attributionOf(
  opts: Pick<ClaimOptions, "workerId" | "worker">,
): JobWorkerRef {
  if (!opts.worker) {
    return { id: opts.workerId };
  }

  return {
    id: opts.workerId,
    key: opts.worker.key,
    host: opts.worker.host,
    pid: opts.worker.pid,
  };
}

/**
 * `workerId` as a driver that keeps the claimer's id in storage after the
 * settle must report it: the stamp's id while the job is `active`, `null`
 * otherwise — so `workerId` keeps meaning "holding it now".
 */
export function holderOf(
  state: JobState,
  processedBy: JobWorkerRef | null | undefined,
): string | null {
  return state === "active" ? (processedBy?.id ?? null) : null;
}

/** Whether a query uses any of the four attribution filters. */
export function usesAttribution(
  query: Pick<
    JobQuery,
    "workerKeys" | "workerIds" | "finishedFrom" | "finishedTo"
  >,
): boolean {
  return (
    query.workerKeys !== undefined ||
    query.workerIds !== undefined ||
    query.finishedFrom !== undefined ||
    query.finishedTo !== undefined
  );
}

/**
 * Whether a driver may be handed a query using the attribution filters: it
 * declares `capabilities.jobAttribution` and has a native `findJobs`. Only
 * `true` counts. Takes a bare `QueueDriver` too — `capabilities` lives on the
 * lifecycle half of the contract — and a driver without them does not qualify.
 */
export function supportsAttributionQuery(
  driver: Pick<QueueDriver, "findJobs"> & {
    /** The driver's declared capabilities, when the object carries them. */
    readonly capabilities?: DriverCapabilities;
  },
): boolean {
  return (
    driver.capabilities?.jobAttribution === true &&
    typeof driver.findJobs === "function"
  );
}

/**
 * A query's attribution filters, normalised once: the lists as sets. `null`
 * means the query uses none of them.
 */
export interface AttributionFilter {
  /** Stable keys to match `processedBy.key` against, or `undefined` for any. */
  workerKeys: Set<string> | undefined;
  /** Incarnation ids to match `processedBy.id` against, or `undefined` for any. */
  workerIds: Set<string> | undefined;
  /** The inclusive lower bound on `finishedOn`, or `undefined` for none. */
  finishedFrom: number | undefined;
  /** The exclusive upper bound on `finishedOn`, or `undefined` for none. */
  finishedTo: number | undefined;
}

/** The attribution filters a query asks for, or `null` when it asks for none. */
export function attributionFilter(
  query: Pick<
    JobQuery,
    "workerKeys" | "workerIds" | "finishedFrom" | "finishedTo"
  >,
): AttributionFilter | null {
  if (!usesAttribution(query)) {
    return null;
  }

  return {
    workerKeys:
      query.workerKeys === undefined ? undefined : new Set(query.workerKeys),
    workerIds:
      query.workerIds === undefined ? undefined : new Set(query.workerIds),
    finishedFrom: query.finishedFrom,
    finishedTo: query.finishedTo,
  };
}

/** Whether a filter carries a `finishedOn` range, from either end. */
export function hasRange(filter: AttributionFilter): boolean {
  return filter.finishedFrom !== undefined || filter.finishedTo !== undefined;
}

/**
 * Whether a job in `state` can match the filter at all: with a range, only a
 * `completed` or `dead` one. A driver skips every other state's storage.
 */
export function canMatchState(
  filter: AttributionFilter,
  state: JobState,
): boolean {
  return !hasRange(filter) || FINISHED_STATES.includes(state);
}

/**
 * Whether nothing in `states` can match, whatever is stored: an empty key or
 * id list, an empty range, or a range over no finished state. A driver may
 * answer an empty page (and a total of `0`) without reading anything.
 */
export function matchesNothing(
  filter: AttributionFilter,
  states: readonly JobState[],
): boolean {
  if (filter.workerKeys?.size === 0 || filter.workerIds?.size === 0) {
    return true;
  }

  if (
    filter.finishedFrom !== undefined &&
    filter.finishedTo !== undefined &&
    filter.finishedTo <= filter.finishedFrom
  ) {
    return true;
  }

  return !states.some((state) => canMatchState(filter, state));
}

/** Whether `finishedOn` lies in the filter's range: `[finishedFrom, finishedTo)`. */
export function inFinishedRange(
  filter: Pick<AttributionFilter, "finishedFrom" | "finishedTo">,
  finishedOn: number | null,
): boolean {
  if (filter.finishedFrom === undefined && filter.finishedTo === undefined) {
    return true;
  }

  if (finishedOn === null) {
    return false;
  }

  return (
    (filter.finishedFrom === undefined || finishedOn >= filter.finishedFrom) &&
    (filter.finishedTo === undefined || finishedOn < filter.finishedTo)
  );
}

/**
 * Whether a record passes the attribution filters — the one definition every
 * backend is compared against. `names`/`search` are `matchesFilter`'s, in
 * `readApis.ts`, and `states` the caller's.
 */
export function matchesAttribution(
  filter: AttributionFilter,
  record: Pick<JobRecord, "state" | "finishedOn" | "processedBy">,
): boolean {
  const stamp = record.processedBy ?? null;

  if (filter.workerKeys) {
    const key = stamp?.key;
    if (key === undefined || !filter.workerKeys.has(key)) {
      return false;
    }
  }

  if (filter.workerIds && (stamp === null || !filter.workerIds.has(stamp.id))) {
    return false;
  }

  if (hasRange(filter)) {
    return (
      FINISHED_STATES.includes(record.state) &&
      inFinishedRange(filter, record.finishedOn)
    );
  }

  return true;
}
