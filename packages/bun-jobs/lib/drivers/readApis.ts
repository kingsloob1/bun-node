import type {
  AddedRange,
  DemandCounts,
  JobPage,
  JobQuery,
  JobRecord,
  JobsDriver,
  JobState,
  QueueDriver,
  QueueRef,
  ThroughputBucket,
  WorkerInfo,
} from "./driver";
import type { JobCursorKey } from "./jobCursor";
import type { BufferWriteResult } from "./metrics";
import { ConfigError, NotSupportedError } from "../shared/errors";
import { compareCodePoints } from "../shared/strings";
import {
  emptyAddedCounts,
  rangeMatchesNothing,
  sortByCreated,
  sortsByCreated,
  supportsCreatedSort,
} from "./added";
import {
  attributionFilter,
  matchesAttribution,
  matchesNothing,
  supportsAttributionQuery,
  usesAttribution,
} from "./attribution";
import { jobOrderFields, seekJobIndex } from "./jobCursor";
import {
  bucketStart,
  JOB_COUNTERS,
  mergeCounterBuckets,
  PendingBuffer,
} from "./metrics";

/**
 * What a management UI reads, and the fallbacks that make each read work on a
 * driver that does not implement it natively.
 *
 * Every method these build on is **optional** on the contract, as the plural
 * claim and completion were: an external driver is a supported extension
 * point, and a required method would break every one written before it. So the
 * queue never calls the optional method directly — it calls the function here,
 * which takes the native path when there is one and a correct, slower one when
 * there is not.
 *
 * The throughput pieces at the end are the minute-resolution special case of
 * the general bucket machinery in `metrics.ts`, and are built on it: the same
 * flooring, the same merge and the same buffer, with the width fixed at a
 * minute and the counters fixed at completed and failed.
 */

/**
 * How long one throughput bucket is: a minute.
 *
 * Written out rather than taken from the contract's `MINUTE_BUCKET_MS`, which
 * is the same number: `__tests__/api/api-contract.test.ts` holds the two equal
 * so that neither can drift, and a reference would make that test say nothing.
 */
export const THROUGHPUT_BUCKET_MS = 60_000;

/**
 * How long throughput buckets are kept, measured back from the latest minute a
 * driver counted in: a day, which is 1,440 buckets per queue at most.
 */
export const THROUGHPUT_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * How often a driver that cannot count inside its completion statement writes
 * what it has gathered: once a second, whatever the rate.
 */
export const THROUGHPUT_FLUSH_MS = 1_000;

/**
 * The queue-state prefix worker records are kept under on a driver with no
 * native worker registry. Distinct from the debounce and throttle prefixes, so
 * their sweep never reads one.
 */
export const WORKER_STATE_PREFIX = "workers:";

/** How many jobs a scan reads at a time, when filtering without a native query. */
const SCAN_PAGE = 500;

/** How many single reads `getJobsByIds` sends at once without a native batch. */
const GET_CONCURRENCY = 16;

/** How many compare-and-set rounds a queue-state worker write tries. */
const WORKER_WRITE_ATTEMPTS = 8;

/** Every job state, in the order counts are reported. */
export const JOB_STATES: readonly JobState[] = [
  "waiting",
  "delayed",
  "active",
  "completed",
  "failed",
  "dead",
  "waiting-children",
];

/** A count of zero for every state. */
export function emptyCounts(): Record<JobState, number> {
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

/** The start of the minute `now` falls in. */
export function throughputBucket(now: number): number {
  return bucketStart(now, THROUGHPUT_BUCKET_MS);
}

/* ------------------------------------------------------------------ *
 * Filtering
 * ------------------------------------------------------------------ */

/**
 * A query's filters, normalised once: `search` lower-cased and dropped when
 * empty, `names` as a set. `null` means the query filters nothing.
 */
export interface JobFilter {
  /** Names to match exactly, or `undefined` for any. */
  names: Set<string> | undefined;
  /** The search, lower-cased, or `undefined` for none. */
  search: string | undefined;
}

/** The filters a query asks for, or `null` when it asks for none. */
export function jobFilter(
  query: Pick<JobQuery, "names" | "search">,
): JobFilter | null {
  const search =
    query.search === undefined || query.search === ""
      ? undefined
      : query.search.toLowerCase();
  const names = query.names === undefined ? undefined : new Set(query.names);

  return search === undefined && names === undefined ? null : { names, search };
}

/**
 * Whether an id and name pass a filter: the name is one of `names`, and the
 * search is a substring of the id or the name, ignoring case.
 */
export function matchesFilter(
  filter: JobFilter,
  id: string,
  name: string,
): boolean {
  if (filter.names && !filter.names.has(name)) {
    return false;
  }

  if (filter.search === undefined) {
    return true;
  }

  return (
    id.toLowerCase().includes(filter.search) ||
    name.toLowerCase().includes(filter.search)
  );
}

/**
 * `value` escaped for a SQL `LIKE` whose escape character is `!`, so `%`, `_`
 * and `!` match themselves. `!` rather than a backslash: MySQL reads a
 * backslash inside a string literal as an escape of its own, so `ESCAPE '\'`
 * cannot be spelled the same way on every engine, and `!` can.
 */
export function escapeLike(value: string): string {
  return value.replace(/[!%_]/g, (character) => `!${character}`);
}

/** `value` escaped so a regular expression matches it literally. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * A page of jobs matching a query, with a total when asked for.
 *
 * The native {@link QueueDriver.findJobs} when the driver has it — and, for a
 * query using the attribution filters (`workerKeys`, `workerIds`,
 * `finishedFrom`, `finishedTo`), only when it also declares
 * `capabilities.jobAttribution`: a `findJobs` written before those fields
 * would ignore them and return every job as a match. Likewise `sort:
 * "createdAt"` only when the driver implements `countAddedJobs`, its promise
 * to honour it. Otherwise:
 *
 * - **no filter** is one `listJobs`, and a total is the sum of those states'
 *   counts, so an unfiltered page costs what it always did plus one count;
 * - **a filter** walks the states in their natural order a page of
 *   {@link SCAN_PAGE} at a time, skipping `offset` matches and keeping `limit`.
 *   Linear in the jobs in those states — it stops early unless a total is
 *   wanted, which has to see every one;
 * - **`sort: "createdAt"`** reads every match, sorts them by `compareCreated`
 *   and cuts the page: correct, but linear in the jobs in those states and
 *   holding every match at once. The queue refuses the sort on a driver that
 *   would land here for that reason; the scan still serves it for a driver
 *   that promises the sort but routes here for another field (an attribution
 *   filter without the capability, or no `findJobs` at all).
 *
 * **A {@link JobQuery.after} cursor is answered by whoever can seek.** A
 * driver declares it honoured one by answering {@link JobPage.offset} — a
 * number, or `null` for "sought, did not count". A driver that answers neither
 * ignored the field, and its page is page one, which a walking client cannot
 * tell from the end of the list: that page is **discarded** and the query
 * re-read by the scan, which always seeks. One wasted read on a backend that
 * cannot seek, and never a silently wrong page.
 */
export async function findJobPage(
  driver: QueueDriver,
  q: QueueRef,
  query: JobQuery,
): Promise<JobPage> {
  if (
    driver.findJobs &&
    (!usesAttribution(query) || supportsAttributionQuery(driver)) &&
    (!sortsByCreated(query) || supportsCreatedSort(driver))
  ) {
    const page = await driver.findJobs(q, query);

    if (query.after === undefined) {
      return page;
    }
    if (page.offset !== undefined) {
      return page;
    }
    // The driver ignored the seek. Fall through to the scan rather than serve
    // its page one.
  }

  return await findJobsByScan(driver, q, query);
}

/** {@link findJobPage} without the native path: exported so it can be tested on every driver. */
export async function findJobsByScan(
  driver: QueueDriver,
  q: QueueRef,
  query: JobQuery,
): Promise<JobPage> {
  const filter = jobFilter(query);
  const attribution = attributionFilter(query);
  const offset = Math.max(0, Math.floor(query.offset));
  const limit = Math.max(0, Math.floor(query.limit));

  if (attribution && matchesNothing(attribution, query.states)) {
    return {
      jobs: [],
      ...(query.total ? { total: 0 } : {}),
      ...(query.after === undefined ? {} : { offset: 0 }),
    };
  }

  const matches = (record: JobRecord): boolean =>
    matchesScan(filter, attribution, record);

  if (query.after !== undefined) {
    return await scanAfterCursor(driver, q, query, query.after, matches);
  }

  if (sortsByCreated(query)) {
    return await scanByCreated(driver, q, query, matches);
  }

  if (!filter && !attribution) {
    const jobs =
      limit === 0
        ? []
        : await driver.listJobs(q, query.states, {
            offset,
            limit,
            order: query.order,
          });

    if (!query.total) {
      return { jobs };
    }

    // A page and a total from two different reads, which on a driver whose
    // listing filters more than its count would not agree. `SqlDriver` writes
    // an `IS NOT NULL` into a single state's listing where a partial index
    // serves it, and `countJobs` shares it (`#countNotNull`) precisely so this
    // stays true. It is latent for that driver either way — it has a native
    // `findJobs`, which answers page and total from one `where`, so this line
    // is only reached for a driver without one, or through `findJobsByScan`
    // called directly. Written down because a latent inconsistency nobody
    // wrote down is how the `countJobs` one survived as long as it did: a
    // driver added here that filters a listing must filter its count too.
    return { jobs, total: sumStates(await driver.countJobs(q), query.states) };
  }

  const jobs: JobRecord[] = [];
  let skip = offset;
  let total = 0;
  let from = 0;

  for (;;) {
    const page = await driver.listJobs(q, query.states, {
      offset: from,
      limit: SCAN_PAGE,
      order: query.order,
    });

    for (const record of page) {
      if (!matchesScan(filter, attribution, record)) {
        continue;
      }

      total++;

      if (skip > 0) {
        skip--;
      } else if (jobs.length < limit) {
        jobs.push(record);
      }
    }

    if (page.length < SCAN_PAGE || (!query.total && jobs.length >= limit)) {
      break;
    }

    from += page.length;
  }

  return query.total ? { jobs, total } : { jobs };
}

/** Whether a record passes a scan's name/search filter and its attribution filter. */
function matchesScan(
  filter: JobFilter | null,
  attribution: ReturnType<typeof attributionFilter>,
  record: JobRecord,
): boolean {
  return (
    (!filter || matchesFilter(filter, record.id, record.name)) &&
    (!attribution || matchesAttribution(attribution, record))
  );
}

/**
 * The scan behind `sort: "createdAt"`: every job in the states, in pages of
 * {@link SCAN_PAGE}, kept when it matches, then sorted by `compareCreated` and
 * cut to the page. It cannot stop early — the newest match may come last in
 * the natural order — so it always knows the total.
 */
async function scanByCreated(
  driver: QueueDriver,
  q: QueueRef,
  query: JobQuery,
  matches: (record: JobRecord) => boolean,
): Promise<JobPage> {
  const offset = Math.max(0, Math.floor(query.offset));
  const limit = Math.max(0, Math.floor(query.limit));
  const matching: JobRecord[] = [];
  let from = 0;

  for (;;) {
    const page = await driver.listJobs(q, query.states, {
      offset: from,
      limit: SCAN_PAGE,
      order: "asc",
    });

    for (const record of page) {
      if (matches(record)) {
        matching.push(record);
      }
    }

    if (page.length < SCAN_PAGE) {
      break;
    }

    from += page.length;
  }

  const jobs = sortByCreated(matching, query.order).slice(
    offset,
    offset + limit,
  );

  return query.total ? { jobs, total: matching.length } : { jobs };
}

/**
 * The scan behind a {@link JobQuery.after} cursor — what serves the seek for
 * any driver that cannot seek in its own store, and the re-read for one that
 * ignored the cursor.
 *
 * It reads every job in the states, in pages of {@link SCAN_PAGE}, keeps the
 * matches in the listing's own order, and hands the whole ordered list to
 * `seekJobIndex`. Reading it whole is what makes the seek exact on a backend
 * whose tie-break is not the id — the memory driver's insertion counter, the
 * file driver's several-state listing, Redis's state-blocked concatenation —
 * because the anchor is then resolved **by identity**, at whatever index the
 * driver itself put it, and only a job that has actually left the listing
 * falls through to comparing keys.
 *
 * Linear in the jobs in those states, and it holds every match at once: the
 * same cost `sort: "createdAt"` already pays here. It is a fallback, not the
 * path any shipped driver takes.
 *
 * It always answers {@link JobPage.offset}, because it has counted the matches
 * it walked past on the way.
 *
 * **Its one precondition, stated because it is not free:** once the anchor job
 * has left the listing, the seek compares the walk's key against the listing,
 * so **the listing must be in the order that key describes**. For a single
 * state that is every backend. For several states it is every backend that
 * follows the driver contract's "several states are ordered by creation" —
 * memory, the file driver, SQL and MongoDB. It is **not** Redis, which
 * concatenates whole sorted sets, state block by state block, each block in
 * that state's own key order; measured against a listing of that shape, this
 * seek lost 3 jobs and repeated 3 of 33, silently. The two readings cannot be
 * told apart from the rows (jobs added in one `addBulk` share a creation
 * millisecond, so a blocked listing is also non-decreasing by `createdAt`), so
 * the repair belongs in the driver, not here: **a driver whose several-state
 * listing is not the contract's must seek for itself**, and Redis does, from
 * {@link JobCursorKey.stateValues}. If a future driver orders several states
 * its own way and cannot seek, it must say so — and this is where the cost
 * lands.
 */
async function scanAfterCursor(
  driver: QueueDriver,
  q: QueueRef,
  query: JobQuery,
  after: JobCursorKey,
  matches: (record: JobRecord) => boolean,
): Promise<JobPage> {
  const limit = Math.max(0, Math.floor(query.limit));
  const byCreated = sortsByCreated(query);
  const matching: JobRecord[] = [];
  let from = 0;

  for (;;) {
    const page = await driver.listJobs(q, query.states, {
      offset: from,
      limit: SCAN_PAGE,
      // `sort: "createdAt"` is put in order below, from one direction, exactly
      // as `scanByCreated` reads it.
      order: byCreated ? "asc" : query.order,
    });

    for (const record of page) {
      if (matches(record)) {
        matching.push(record);
      }
    }

    if (page.length < SCAN_PAGE) {
      break;
    }

    from += page.length;
  }

  const ordered = byCreated ? sortByCreated(matching, query.order) : matching;
  const offset = seekJobIndex(
    ordered,
    after,
    jobOrderFields(query.states, query.sort),
    query.order,
  );

  return {
    jobs: ordered.slice(offset, offset + limit),
    ...(query.total ? { total: ordered.length } : {}),
    offset,
  };
}

/** The sum of the counts of some states, each counted once. */
export function sumStates(
  counts: Record<JobState, number>,
  states: JobState[],
): number {
  let sum = 0;
  for (const state of new Set(states)) {
    sum += counts[state] ?? 0;
  }
  return sum;
}

/* ------------------------------------------------------------------ *
 * Batch reads
 * ------------------------------------------------------------------ */

/**
 * Several jobs by id: one entry per id in the order given, `null` for a
 * missing one. The native {@link QueueDriver.getJobs} when the driver has it,
 * otherwise {@link getJobsByLoop}.
 */
export async function getJobsByIds(
  driver: QueueDriver,
  q: QueueRef,
  ids: string[],
): Promise<(JobRecord | null)[]> {
  if (ids.length === 0) {
    return [];
  }

  if (driver.getJobs) {
    return await driver.getJobs(q, ids);
  }

  return await getJobsByLoop(driver, q, ids);
}

/**
 * {@link getJobsByIds} through `getJob`, {@link GET_CONCURRENCY} at a time, and
 * each distinct id read once however often it is given.
 */
export async function getJobsByLoop(
  driver: QueueDriver,
  q: QueueRef,
  ids: string[],
): Promise<(JobRecord | null)[]> {
  const distinct = [...new Set(ids)];
  const found = new Map<string, JobRecord | null>();

  for (let at = 0; at < distinct.length; at += GET_CONCURRENCY) {
    const chunk = distinct.slice(at, at + GET_CONCURRENCY);
    const records = await Promise.all(
      chunk.map(async (id) => await driver.getJob(q, id)),
    );
    chunk.forEach((id, index) => found.set(id, records[index] ?? null));
  }

  return orderByIds(ids, found);
}

/**
 * Answers `ids` in order from records found in any order: a record per id,
 * `null` where none was found. Each answer is its own object, so a caller
 * changing one entry of a repeated id does not change the other.
 */
export function orderByIds(
  ids: string[],
  found: Map<string, JobRecord | null>,
): (JobRecord | null)[] {
  const seen = new Set<string>();

  return ids.map((id) => {
    const record = found.get(id) ?? null;
    if (!record) {
      return null;
    }
    if (seen.has(id)) {
      return structuredClone(record);
    }
    seen.add(id);
    return record;
  });
}

/* ------------------------------------------------------------------ *
 * Workers
 * ------------------------------------------------------------------ */

/**
 * Whether a driver can keep worker records at all: natively, or in queue
 * state.
 */
export function supportsWorkers(driver: QueueDriver): boolean {
  return (
    hasNativeWorkers(driver) ||
    (typeof driver.getQueueState === "function" &&
      typeof driver.setQueueState === "function" &&
      typeof driver.listQueueState === "function")
  );
}

/** Whether a driver implements all three worker methods itself. */
function hasNativeWorkers(driver: QueueDriver): boolean {
  return (
    typeof driver.registerWorker === "function" &&
    typeof driver.removeWorker === "function" &&
    typeof driver.listWorkers === "function"
  );
}

/**
 * Writes a worker's record: natively, or as a queue-state entry named
 * `workers:<id>`.
 *
 * The queue-state path costs a read and a compare-and-set per report, which at
 * one report every few seconds is nothing — and never anything per job. A write
 * that keeps losing the compare-and-set is given up rather than retried
 * forever: the next report writes again.
 */
export async function registerWorkerRecord(
  driver: QueueDriver,
  q: QueueRef,
  worker: WorkerInfo,
): Promise<void> {
  if (hasNativeWorkers(driver)) {
    await driver.registerWorker!(q, worker);
    return;
  }

  const name = `${WORKER_STATE_PREFIX}${worker.id}`;

  for (let attempt = 0; attempt < WORKER_WRITE_ATTEMPTS; attempt++) {
    const current = await driver.getQueueState!(q, name);
    const written = await driver.setQueueState!(
      q,
      name,
      worker,
      current?.version ?? null,
    );

    if (written !== null) {
      break;
    }
  }

  // Records lapsed as of this report go now, not only when somebody lists: a
  // queue nobody watches would otherwise keep every dead worker's entry.
  await listWorkerRecords(driver, q, worker.heartbeatAt);
}

/** Removes a worker's record, answering whether there was one. */
export async function removeWorkerRecord(
  driver: QueueDriver,
  q: QueueRef,
  id: string,
): Promise<boolean> {
  if (hasNativeWorkers(driver)) {
    return await driver.removeWorker!(q, id);
  }

  const name = `${WORKER_STATE_PREFIX}${id}`;

  for (let attempt = 0; attempt < WORKER_WRITE_ATTEMPTS; attempt++) {
    const current = await driver.getQueueState!(q, name);
    if (!current) {
      return false;
    }

    if (
      (await driver.setQueueState!(q, name, null, current.version)) !== null
    ) {
      return true;
    }
  }

  return false;
}

/**
 * The live workers on a queue at `now`, ordered by `startedAt` then id.
 *
 * Through queue state this is a listing and a read per record, and every
 * lapsed record found is deleted on the way — conditionally on the version
 * read, so a worker that reported again in between keeps its record.
 */
export async function listWorkerRecords(
  driver: QueueDriver,
  q: QueueRef,
  now: number,
): Promise<WorkerInfo[]> {
  if (hasNativeWorkers(driver)) {
    return await driver.listWorkers!(q, now);
  }

  const live: WorkerInfo[] = [];
  let after: string | undefined;

  for (;;) {
    const names = await driver.listQueueState!(q, {
      prefix: WORKER_STATE_PREFIX,
      limit: 200,
      ...(after !== undefined ? { after } : {}),
    });

    for (const name of names) {
      const entry = await driver.getQueueState!(q, name);
      const worker = entry?.value as WorkerInfo | undefined;

      if (!entry || !worker) {
        continue;
      }

      if (worker.expiresAt > now) {
        live.push(worker);
      } else {
        await driver.setQueueState!(q, name, null, entry.version);
      }
    }

    if (names.length < 200) {
      break;
    }

    after = names.at(-1);
  }

  return sortWorkers(live);
}

/** Workers ordered by when they started, then by id. */
export function sortWorkers(workers: WorkerInfo[]): WorkerInfo[] {
  return workers.sort(
    (a, b) =>
      a.startedAt - b.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/* ------------------------------------------------------------------ *
 * Demand
 * ------------------------------------------------------------------ */

/**
 * How far {@link readDemand} counts each figure by default. Past it a figure
 * reads `10_000` and `capped` is `true`: a scaler targeting one worker per
 * 500 jobs needs no more.
 */
export const DEFAULT_DEMAND_CAP = 10_000;

/** A queue's demand at one instant: what a summoner and the depth endpoint read. */
export interface QueueDemand {
  /** The instant it describes, epoch ms: the `now` it was computed at. */
  at: number;
  /** Whether claiming is paused. A paused queue demands nothing. */
  paused: boolean;
  /** Jobs in `waiting`. */
  waiting: number;
  /** Jobs in `delayed` or `failed` (retry pending) whose `runAt` has passed. */
  dueNow: number;
  /**
   * Jobs in `active` whose worker died holding them: the ones this driver's
   * stalled sweep would recover now (see {@link DemandCounts.stalled}).
   */
  stalled: number;
  /** Jobs in `active`, lapsed or not. */
  active: number;
  /**
   * Live workers on the queue, from its heartbeat records — every live record,
   * parked and paused ones included: the question it answers is whether
   * anything alive may still hold the active jobs' locks. `0` on a driver that
   * keeps no worker records.
   */
  workers: number;
  /** The earliest `runAt` still in the future, or `null` for none. */
  nextDueAt: number | null;
  /** `paused ? 0 : waiting + dueNow + stalled`: work a worker could claim now. */
  demand: number;
  /**
   * `paused ? 0 : demand + (active − stalled)`: everything not finished, each
   * job once — a stalled job is in both `stalled` and `active`.
   */
  outstanding: number;
  /**
   * `true` when a count reached the cap, so the true figure is at least this
   * one. `demand` and `outstanding` are sums of capped figures, so they can
   * exceed the cap, and are lower bounds when this is set.
   */
  capped: boolean;
  /**
   * `false` when the driver has no `countDemand` and the figures come from the
   * fallback: `dueNow` is then `1` or `0` (from `nextDelayedAt`), `stalled` is
   * `active` when no worker is live, and `nextDueAt` is known only while
   * nothing is due. Correct as a trigger, approximate as a count.
   */
  exact: boolean;
}

/**
 * Raw counts reported under a cap, the way {@link DemandCounts} requires:
 * each figure as `min(count, cap)`, and `capped` when any reached past it.
 *
 * A driver counts each figure up to `cap + 1` and hands the counts here, so
 * "exactly `cap`" and "more than `cap`" stay apart. `nextDueAt` passes
 * through: it is one probe, never capped.
 */
export function capDemandCounts(
  counts: Omit<DemandCounts, "capped">,
  cap: number,
): DemandCounts {
  const figures = [
    counts.waiting,
    counts.dueNow,
    counts.stalled,
    counts.active,
  ];

  return {
    waiting: Math.min(counts.waiting, cap),
    dueNow: Math.min(counts.dueNow, cap),
    stalled: Math.min(counts.stalled, cap),
    active: Math.min(counts.active, cap),
    nextDueAt: counts.nextDueAt,
    capped: figures.some((figure) => figure > cap),
  };
}

/** Refuses a cap that is not a positive safe integer. */
export function assertDemandCap(cap: number): void {
  if (!Number.isSafeInteger(cap) || cap < 1) {
    throw new ConfigError(
      `A demand cap must be a positive integer, got ${String(cap)}`,
      { cap },
    );
  }
}

/**
 * The order a driver whose `countDemand` reads are separate round trips (the
 * file and MongoDB drivers) takes them in: every source before its
 * destination. Recovery moves `active` → `waiting` and promotion moves
 * `delayed`/`failed` → `waiting`, so reading `active` and the due jobs before
 * `waiting` counts a job either moves mid-call twice at worst, never zero
 * times. A claim moves `waiting` → `active`, the other way, so a job claimed
 * mid-call can be in neither: `demand` is still right (a claimed job is not
 * demand), and `outstanding` is short by it until the next read.
 */
export const DEMAND_READ_ORDER = ["active", "dueNow", "waiting"] as const;

/** One of `countDemand`'s separate reads: see {@link DEMAND_READ_ORDER}. */
export type DemandRead = (typeof DEMAND_READ_ORDER)[number];

/**
 * A test seam on a separate-read driver: set under
 * {@link DEMAND_READ_PROBE} on the driver instance, it runs code between
 * `countDemand`'s reads, and can reorder them for a negative control. Nothing
 * in the package sets it.
 */
export interface DemandReadProbe {
  /**
   * The order to take the reads in instead of {@link DEMAND_READ_ORDER}. Only
   * a negative control sets it, to show that the wrong order loses a job.
   */
  order?: readonly DemandRead[];
  /** Called after each read completes, before the next begins. */
  after?: (read: DemandRead) => Promise<void> | void;
}

/** The property a {@link DemandReadProbe} is set under on a driver instance. */
export const DEMAND_READ_PROBE: unique symbol = Symbol.for(
  "@kingsleyweb/bun-jobs:demand-read-probe",
);

/**
 * Takes a separate-read driver's `countDemand` reads in
 * {@link DEMAND_READ_ORDER}, or as a {@link DemandReadProbe} set on `driver`
 * says.
 */
export async function runDemandReads(
  driver: object,
  reads: Record<DemandRead, () => Promise<void>>,
): Promise<void> {
  const probe = (driver as { [DEMAND_READ_PROBE]?: DemandReadProbe })[
    DEMAND_READ_PROBE
  ];

  for (const read of probe?.order ?? DEMAND_READ_ORDER) {
    await reads[read]();
    await probe?.after?.(read);
  }
}

/**
 * A queue's demand at `now`: the driver's {@link QueueDriver.countDemand},
 * plus whether the queue is paused and how many workers are live.
 *
 * On a driver without `countDemand` it falls back to `countJobs`,
 * `nextDelayedAt` and the worker records, and says so with `exact: false`:
 *
 * ```
 * demand = waiting + (nextDelayedAt <= now ? 1 : 0) + (active > 0 && workers == 0 ? active : 0)
 * ```
 *
 * which is right as a trigger and approximate as a count, and whose
 * `countJobs` may scan retained history. Listing the worker records drops
 * lapsed ones on a driver that keeps them in queue state, as every listing
 * does; the driver's own count writes nothing.
 */
export async function readDemand(
  driver: QueueDriver,
  q: QueueRef,
  options: {
    /** The instant to read at, epoch ms. Defaults to `Date.now()`. */
    now?: number;
    /** Count each figure up to this many. Defaults to {@link DEFAULT_DEMAND_CAP}. */
    cap?: number;
  } = {},
): Promise<QueueDemand> {
  const now = options.now ?? Date.now();
  const cap = options.cap ?? DEFAULT_DEMAND_CAP;
  assertDemandCap(cap);

  const pending = Promise.all([
    driver.isQueuePaused(q),
    supportsWorkers(driver)
      ? listWorkerRecords(driver, q, now).then((live) => live.length)
      : Promise.resolve(0),
  ]);

  let paused: boolean;
  let workers: number;
  let counts: DemandCounts;
  let exact: boolean;

  if (typeof driver.countDemand === "function") {
    [[paused, workers], counts] = await Promise.all([
      pending,
      driver.countDemand(q, now, { cap }),
    ]);
    exact = true;
  } else {
    const [byState, next] = await Promise.all([
      driver.countJobs(q),
      driver.nextDelayedAt(q),
    ]);
    [paused, workers] = await pending;
    counts = capDemandCounts(
      {
        waiting: byState.waiting,
        dueNow: next !== null && next <= now ? 1 : 0,
        stalled: byState.active > 0 && workers === 0 ? byState.active : 0,
        active: byState.active,
        nextDueAt: next !== null && next > now ? next : null,
      },
      cap,
    );
    exact = false;
  }

  const demand = paused ? 0 : counts.waiting + counts.dueNow + counts.stalled;

  return {
    at: now,
    paused,
    waiting: counts.waiting,
    dueNow: counts.dueNow,
    stalled: counts.stalled,
    active: counts.active,
    workers,
    nextDueAt: counts.nextDueAt,
    demand,
    outstanding: paused ? 0 : demand + (counts.active - counts.stalled),
    capped: counts.capped,
    exact,
  };
}

/* ------------------------------------------------------------------ *
 * Aggregates
 * ------------------------------------------------------------------ */

/**
 * Counts per state for every queue in a namespace: every queue `listQueues`
 * names, and any the counts name that it does not, each with every state.
 *
 * The native {@link QueueDriver.countJobsByQueue} is one query; without it,
 * one `countJobs` per queue.
 */
export async function countQueues(
  driver: JobsDriver,
  ns: string,
): Promise<Map<string, Record<JobState, number>>> {
  const names = await driver.listQueues(ns);
  const counts = new Map<string, Record<JobState, number>>();

  if (driver.countJobsByQueue) {
    const grouped = await driver.countJobsByQueue(ns);

    for (const name of new Set([...names, ...Object.keys(grouped)])) {
      counts.set(name, { ...emptyCounts(), ...grouped[name] });
    }
  } else {
    for (const name of names) {
      counts.set(name, await driver.countJobs({ ns, queue: name }));
    }
  }

  return new Map([...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * Of the jobs added in a range, how many are in each state now, per queue:
 * {@link QueueDriver.countAddedJobs}, with its answer made whole — every state
 * of every queue present. With `queue`, the answer has exactly that key, zeros
 * when none of its jobs is in the range; without, every queue that has one.
 *
 * No fallback: a driver without the method is asked for something it cannot
 * answer cheaply, so this throws {@link NotSupportedError} (a `ConfigError`).
 * Check {@link supportsCreatedSort} first to branch instead.
 */
export async function countAdded(
  driver: Pick<QueueDriver, "countAddedJobs"> & {
    /** The driver's name, for the error. */
    readonly name: string;
  },
  ns: string,
  range: AddedRange,
  queue?: string,
): Promise<Record<string, Record<JobState, number>>> {
  if (!driver.countAddedJobs) {
    throw new NotSupportedError(driver.name, "countAddedJobs");
  }

  const grouped = rangeMatchesNothing(range)
    ? {}
    : await driver.countAddedJobs(ns, range, queue);
  const names = queue === undefined ? Object.keys(grouped) : [queue];
  const result: Record<string, Record<JobState, number>> = {};

  for (const name of names.sort(compareCodePoints)) {
    result[name] = { ...emptyAddedCounts(), ...grouped[name] };
  }

  return result;
}

/* ------------------------------------------------------------------ *
 * Throughput
 * ------------------------------------------------------------------ */

/**
 * Buckets summed by minute, oldest first, dropping any outside `[from, to]`
 * and any with nothing in them. For a backend that stores a minute in more
 * than one row — one per process, so writers never contend on a row.
 *
 * {@link mergeCounterBuckets} at the minute, over the two throughput counters:
 * the same merge every analytics series uses, so a backend cannot answer one
 * of them differently from the other.
 */
export function sumBuckets(
  rows: Iterable<{ at: number; completed: number; failed: number }>,
  range: { from: number; to: number },
): ThroughputBucket[] {
  return mergeCounterBuckets(rows, range, JOB_COUNTERS);
}

/** Counts gathered for one queue and minute, waiting to be written. */
export interface PendingThroughput {
  /** The queue. */
  q: QueueRef;
  /** The minute. */
  at: number;
  /** Jobs completed. */
  completed: number;
  /** Attempts failed. */
  failed: number;
}

/**
 * What a throughput writer answers with: the counts that did not land, and why
 * — so only those are written again, and the failure still reaches whoever
 * asked for the write. {@link BufferWriteResult} over the throughput entry.
 */
export interface ThroughputWriteResult extends BufferWriteResult<PendingThroughput> {
  /** Counts that did not land, to be written again on the next tick. */
  unwritten: PendingThroughput[];
  /**
   * The first failure behind them, when there was one. The flush that wrote
   * the batch rejects with it once the unwritten counts are back.
   */
  error?: unknown;
}

/**
 * Throughput counts gathered in memory and written once a second, for a
 * backend that cannot count inside its completion statement.
 *
 * Counting a job is a `Map` update — no I/O — and the write is one statement
 * per second per process however many jobs finished, so no job ever pays a
 * round trip for it. The price is honesty about two things: a count reaches
 * the backend up to {@link THROUGHPUT_FLUSH_MS} after the job finished, and a
 * process that dies hard loses what it had not written yet.
 *
 * A writer answers with the counts that did **not** land, and only those are
 * merged back and tried again on the next tick. Putting the whole batch back
 * on any failure — as this first did — counted twice everything that had
 * landed before the failure: the SQL writer's upserts are separate statements,
 * and both writers delete old minutes after writing.
 *
 * The timer is unref'd and started only once something is counted, so an idle
 * driver holds no process open and does no work.
 *
 * All of that is {@link PendingBuffer}, which this is a thin naming of: the
 * minute as the width, a queue as the entity, completed and failed as the
 * counters. The analytics buffers are the same engine with other widths and
 * other counters, so a fix to either reaches both.
 */
export class ThroughputBuffer {
  /** The gathering and flushing engine, keyed by queue and minute. */
  readonly #buffer: PendingBuffer<PendingThroughput>;

  constructor(
    /**
     * Writes one batch of counts and answers with those that did not land and
     * why; called at most once at a time. Throwing puts the whole batch back,
     * so a writer that can tell what landed should answer rather than throw.
     */
    write: (batch: PendingThroughput[]) => Promise<ThroughputWriteResult>,
  ) {
    this.#buffer = new PendingBuffer<PendingThroughput>({
      write,
      key: (entry) => `${entry.q.ns}\n${entry.q.queue}\n${entry.at}`,
      merge: (into, from) => {
        into.completed += from.completed;
        into.failed += from.failed;
      },
      ns: (entry) => entry.q.ns,
      flushMs: THROUGHPUT_FLUSH_MS,
    });
  }

  /** Counts one completion or failure for a queue at `now`. */
  add(q: QueueRef, now: number, completed: number, failed: number): void {
    if (completed === 0 && failed === 0) {
      return;
    }

    this.#buffer.add({ q, at: throughputBucket(now), completed, failed });
  }

  /** Forgets everything counted for a namespace, as purging it must. */
  forget(ns: string): void {
    this.#buffer.forget(ns);
  }

  /**
   * Writes everything counted so far, waiting for a write already in flight
   * first. Resolves once nothing counted before the call is still pending.
   */
  async flush(): Promise<void> {
    await this.#buffer.flush();
  }

  /** Stops the timer and writes what is left. */
  async close(): Promise<void> {
    await this.#buffer.close();
  }
}
