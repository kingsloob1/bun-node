import type { JobListSort } from "../api/contract/constants";
import type { JobRecord, JobState } from "./driver";
import type { CursorPart, CursorPartType } from "./pageCursor";
import { ConfigError } from "../shared/errors";
import { compareCodePoints } from "../shared/strings";
import { decodePageCursor, encodePageCursor } from "./pageCursor";

/**
 * Paging `GET /queues/{queue}/jobs` — and `BunQueue.walk` — with a **keyset
 * cursor** instead of an offset.
 *
 * This is the same convention the runner history uses (`runHistory.ts`), on
 * the route the convention was built for. An offset probe of 868 trials found
 * **1,259 unreachable jobs on this listing and none anywhere else**, every one
 * of them on `order=asc`, and 94 of those 217 trials lost jobs without a
 * single repeat to announce it. An offset counts rows, so a row leaving the
 * list ahead of the window slides every later row *under* the count and the
 * next page steps straight over the ones that moved. A cursor names the last
 * row a page showed, so nothing shifts under it.
 *
 * Three rules, from `pageCursor.ts`, and none of them is this route's taste:
 *
 * 1. **Opaque and server-minted.** A client never builds one. It holds the
 *    backend's ordering key, and the backends do not agree on it: Redis orders
 *    its wait set by a sequence carried in the sorted-set member, and the
 *    memory driver orders `waiting` by the same insertion counter its claim
 *    order rests on, where SQL, MongoDB and the file driver break every tie on
 *    the id. Encoding the key keeps it the server's business and lets it
 *    change without a breaking API change.
 * 2. **Bound to its walk**, by {@link JobListWalk}: the namespace, the queue,
 *    the states, the sort and the order. Every parameter that decides what the
 *    walk visits and in what sequence. A cursor naming another walk is refused
 *    rather than resumed somewhere that means nothing.
 * 3. **A bad one is 400 `INVALID_ARGUMENT`, never a quiet page one** — which a
 *    walking client cannot tell from the end of the list.
 *
 * And one rule of its own, which is what makes the seek work while the queue
 * moves: **the key is a value, not a position.** The seek compares keys, so it
 * never needs the job it is anchored on to still be there — the ordinary case
 * on a queue that is draining, where the row a page ended on is claimed a
 * moment later.
 */

/** What every jobs-list cursor starts with, and its format version. */
export const JOB_LIST_CURSOR_PREFIX = "jl1.";

/** Which listing a jobs-list cursor belongs to. */
const JOB_LIST_CURSOR_KIND = "jobsList";

/**
 * A field a job listing is ordered by, ahead of the id that breaks its ties.
 *
 * One per column every driver already sorts on: SQL's `#listOrder`, MongoDB's
 * `#listSort`, the memory driver's `#sortKey` and the file driver's marker
 * names all name the same five.
 */
export type JobOrderField =
  | "priority"
  | "createdAt"
  | "runAt"
  | "lockExpiresAt"
  | "finishedOn";

/**
 * The fields a listing's order rests on, before the id tie-break — the single
 * definition of what a cursor's key holds, so it cannot drift from the
 * `ORDER BY`, the `sort()` and the comparators that produce the page.
 *
 * It is exactly `listJobs`' documented order: one state by its own key,
 * several states by creation, and `sort: "createdAt"` by creation whatever the
 * states.
 */
export function jobOrderFields(
  /** The states being listed. */
  states: readonly JobState[],
  /** The sort asked for; `"natural"` and `undefined` are the same query. */
  sort: JobListSort | undefined,
): JobOrderField[] {
  if (sort === "createdAt") {
    return ["createdAt"];
  }

  const single = states.length === 1 ? states[0] : undefined;

  switch (single) {
    case "waiting":
      return ["priority", "createdAt"];
    case "delayed":
    case "failed":
      return ["runAt"];
    case "active":
      return ["lockExpiresAt"];
    case "completed":
    case "dead":
      return ["finishedOn"];
    default:
      return ["createdAt"];
  }
}

/**
 * Whether a walk can be paged by cursor at all.
 *
 * Every order but one: **a single `active` state in its natural order is
 * refused**, because `lockExpiresAt` is rewritten every time a worker renews
 * its lock — several times a minute, per job, with no operator involved. A
 * cursor there would be re-anchored against a key that has already moved, so
 * it is no more stable than the offset it replaced, and pretending otherwise
 * is worse than the offset. `active` stays on offset; a client that wants a
 * stable walk over it asks for `sort=createdAt`, which is immutable.
 *
 * `delayed` and `failed` are *not* refused, although `runAt` moves too: it
 * moves only when a job actually retries, which is the same rare, deliberate
 * class as an operator re-prioritising a waiting job — documented, not
 * refused.
 */
export function jobWalkIsSeekable(
  /** The states being listed. */
  states: readonly JobState[],
  /** The sort asked for. */
  sort: JobListSort | undefined,
): boolean {
  return !(
    sort !== "createdAt" &&
    states.length === 1 &&
    states[0] === "active"
  );
}

/**
 * Where a jobs-list walk stopped: the ordering key of the last job a page
 * returned.
 *
 * A **value, not a position** — the seek compares it and never needs the job
 * to still be listed, which is the whole point on a queue that drains.
 */
export interface JobCursorKey {
  /**
   * The order's leading values, in the order {@link jobOrderFields} names
   * them for this walk.
   */
  values: number[];
  /**
   * The job's id: the tie-break, and what makes the key total. Ties are not
   * an edge case here — jobs added in one `addBulk` share a priority and a
   * creation millisecond, so a bulk-seeded queue ties on essentially every
   * adjacent pair and the tie-break is what decides the whole order.
   */
  id: string;
  /**
   * The state the job was in when the page was read.
   *
   * Carried for a backend whose listing of several states is **blocked by
   * state** rather than merged by creation time — Redis concatenates whole
   * sorted sets — which needs to know which block to resume in. Every other
   * backend ignores it.
   */
  state: JobState;
  /**
   * The job's place in **its own state's** natural order: the values of
   * `jobOrderFields([state], "natural")`, padded to two.
   *
   * Carried only on a several-state walk, and only because one backend needs
   * it. `values` there is the creation time, which is the order the driver
   * contract declares for several states and the order memory, the file
   * driver, SQL and MongoDB actually answer in. Redis does not: it
   * concatenates whole sorted sets, so its several-state listing runs
   * state-block by state-block, each block in that state's own key order —
   * `waiting` by priority. Resuming there needs the anchor's *priority*, and a
   * creation time cannot supply it.
   *
   * Measured before this field existed: a several-state walk over Redis whose
   * anchor was removed outright lost 3 jobs and repeated 3 of 33, **silently**
   * — the exact failure this cursor exists to remove, reintroduced in its own
   * fallback. Empty on a single-state walk, where the walk's own values are
   * already that state's key.
   */
  stateValues: number[];
}

/** Everything that decides what a jobs-list walk visits, and in what order. */
export interface JobListWalk {
  /** The namespace the queue lives in. */
  ns: string;
  /** The queue, as the request named it. */
  queue: string;
  /** The states being listed. */
  states: readonly JobState[];
  /** The sort asked for; `undefined` is `"natural"`. */
  sort: JobListSort | undefined;
  /** The direction being walked; a cursor minted the other way is refused. */
  order: "asc" | "desc";
}

/**
 * A walk's binding as the cursor codec stores it.
 *
 * The states are sorted and joined, so `state=waiting&state=delayed` and
 * `state=delayed&state=waiting` are one walk — they list the same jobs in the
 * same order, and refusing a cursor between them would be a refusal with no
 * cause.
 */
function walkParts(walk: JobListWalk): CursorPart[] {
  return [
    walk.ns,
    walk.queue,
    [...walk.states].sort().join(","),
    walk.sort ?? "natural",
    walk.order,
  ];
}

/**
 * Whether this walk's key carries {@link JobCursorKey.stateValues}.
 *
 * Only a **several-state natural** walk does, because only there can the
 * walk's own key (creation time) fail to describe the listing a backend
 * answers — see {@link JobCursorKey.stateValues}. A single state, and
 * `sort=createdAt`, are the same order on every backend that serves them, so
 * the extra values would be dead weight in every cursor.
 */
function carriesStateKey(walk: JobListWalk): boolean {
  return walk.sort !== "createdAt" && walk.states.length !== 1;
}

/** What each part of this walk's key must decode as. */
function keyTypes(walk: JobListWalk): CursorPartType[] {
  return [
    ...jobOrderFields(walk.states, walk.sort).map(
      (): CursorPartType => "number",
    ),
    "string",
    "string",
    ...(carriesStateKey(walk)
      ? (["number", "number"] satisfies CursorPartType[])
      : []),
  ];
}

/** The value a record carries for one order field. */
export function jobFieldValue(
  /** The job. */
  record: JobRecord,
  /** Which of its ordering fields to read. */
  field: JobOrderField,
): number {
  switch (field) {
    case "priority":
      return record.priority;
    case "runAt":
      return record.runAt;
    case "lockExpiresAt":
      // The fallbacks the memory driver's `#sortKey` uses, for a record in a
      // state that should always carry the field but does not — a restored
      // record, or one written by an older version.
      return record.lockExpiresAt ?? record.processedOn ?? record.createdAt;
    case "finishedOn":
      return record.finishedOn ?? record.createdAt;
    default:
      return record.createdAt;
  }
}

/**
 * A job's place in its **own** state's natural order, padded to two values.
 *
 * Fixed width so the cursor's shape does not depend on which state the anchor
 * happened to be in — the codec checks the key part by part, and a key whose
 * length varied with its own contents could not be checked at all.
 */
export function jobStateKey(
  /** The job the page ended on. */
  record: JobRecord,
): number[] {
  const values = jobOrderFields([record.state], "natural").map((field) =>
    jobFieldValue(record, field),
  );

  return [values[0] ?? 0, values[1] ?? 0];
}

/** The ordering key of a job, for a walk ordered by `fields`. */
export function jobCursorKey(
  /** The job the page ended on. */
  record: JobRecord,
  /** The walk's ordering fields, from {@link jobOrderFields}. */
  fields: readonly JobOrderField[],
): JobCursorKey {
  return {
    values: fields.map((field) => jobFieldValue(record, field)),
    id: record.id,
    state: record.state,
    stateValues: jobStateKey(record),
  };
}

/**
 * Mints the opaque `page.next` for a jobs page: a cursor resuming `walk` after
 * `key`.
 *
 * Bound to the queue, the states, the sort *and* the order, so a cursor
 * replayed after any of them changed is refused rather than resumed from a
 * position that means something else there.
 */
export function encodeJobCursor(
  /** Which walk the cursor continues. */
  walk: JobListWalk,
  /** The last job the page returned. */
  key: JobCursorKey,
): string {
  return encodePageCursor(
    JOB_LIST_CURSOR_PREFIX,
    JOB_LIST_CURSOR_KIND,
    walkParts(walk),
    [
      ...key.values,
      key.id,
      key.state,
      ...(carriesStateKey(walk)
        ? [key.stateValues[0] ?? 0, key.stateValues[1] ?? 0]
        : []),
    ],
  );
}

/**
 * The seek key inside a cursor from {@link encodeJobCursor}, or a
 * `ConfigError` — answered `400 INVALID_ARGUMENT` — when it is not one of this
 * route's cursors or belongs to another walk.
 *
 * The two refusals carry different messages because they are different
 * mistakes: a malformed, truncated or foreign-prefixed cursor was never
 * usable, while a well-formed one naming another walk is usually a real cursor
 * sent to the wrong place — the same page re-requested after a filter changed
 * the states, or after the order was flipped.
 */
export function decodeJobCursor(
  /** The cursor as the client sent it. */
  cursor: string,
  /** The walk being asked for. */
  walk: JobListWalk,
): JobCursorKey {
  const parts = decodePageCursor(
    cursor,
    JOB_LIST_CURSOR_PREFIX,
    JOB_LIST_CURSOR_KIND,
    walkParts(walk),
    keyTypes(walk),
  );
  const carries = carriesStateKey(walk);
  const head = carries ? parts.slice(0, -4) : parts.slice(0, -2);
  const tail = carries ? parts.slice(-4) : parts.slice(-2);

  return {
    values: head as number[],
    id: tail[0] as string,
    state: tail[1] as JobState,
    stateValues: carries ? (tail.slice(2) as number[]) : [],
  };
}

/**
 * How `record` sorts against `key` in the walk's ascending order: negative
 * before, zero the same job, positive after.
 *
 * By the order's own fields, then the id — compared by code point, the
 * comparison `compareCreated` makes and the one every backend's `id` column,
 * `_id` and marker name gives (SQL names an explicit binary collation for it,
 * MongoDB compares UTF-8 bytes, the file driver's markers are encoded names).
 */
export function compareJobKey(
  /** The job being considered for the page. */
  record: JobRecord,
  /** Where the previous page stopped. */
  key: JobCursorKey,
  /** The walk's ordering fields. */
  fields: readonly JobOrderField[],
): number {
  for (const [index, field] of fields.entries()) {
    const value = jobFieldValue(record, field);
    const against = key.values[index] ?? 0;

    if (value !== against) {
      return value - against;
    }
  }

  return compareCodePoints(record.id, key.id);
}

/** Whether `record` sorts strictly after `key` in the direction being walked. */
export function isAfterJob(
  /** The job being considered for the page. */
  record: JobRecord,
  /** Where the previous page stopped. */
  key: JobCursorKey,
  /** The walk's ordering fields. */
  fields: readonly JobOrderField[],
  /** The direction being walked. */
  order: "asc" | "desc",
): boolean {
  const sign = order === "asc" ? 1 : -1;

  return compareJobKey(record, key, fields) * sign > 0;
}

/**
 * Where a page seeking past `key` starts, in a listing already put in the
 * order being walked.
 *
 * Two steps, and the second is what makes the cursor a value rather than a
 * position:
 *
 * 1. **The job is still listed** — resume immediately after it, by index.
 *    Exact whatever the keys do, and it is what lets this serve a backend
 *    whose tie-break is not the id: the memory driver orders ties by an
 *    insertion counter and the file driver's several-state listing does not
 *    break ties at all, and neither can be off by a row while the anchor is
 *    still there.
 * 2. **It is gone** — claimed, completed, removed, or moved out of the states
 *    asked for — so fall back to the key itself and resume at the first job
 *    sorting strictly after it. This is the ordinary case on a draining queue,
 *    and it is why the cursor is a value.
 *
 * **Step 2 assumes the listing is in the order the key describes, and that is
 * a real precondition, not a formality.** It holds for a single state
 * everywhere, and for several states on every backend that follows the driver
 * contract's "several states are ordered by creation" — memory, the file
 * driver, SQL and MongoDB. It does **not** hold on Redis, whose several-state
 * listing concatenates whole sorted sets, state block by state block, each
 * block in that state's own key order. Measured against a listing of that
 * shape: **3 jobs lost and 3 repeated over a 33-job walk, silently** — the
 * very failure the cursor exists to remove, reappearing in its own fallback.
 *
 * It cannot be repaired here, and it is worth saying why rather than leaving
 * it as an omission: the two readings of such a listing cannot be told apart
 * from the listing. Jobs added in one `addBulk` share a creation millisecond,
 * so a state-blocked listing is *also* trivially non-decreasing by
 * `createdAt`, and no test on the rows distinguishes "ordered by creation"
 * from "ordered by something creation cannot see". The seek has to happen
 * where the order is known, which is the driver — so a driver whose
 * several-state listing is not the contract's **must seek for itself**, and
 * Redis does, using {@link JobCursorKey.stateValues}. This function is the
 * fallback for drivers that follow the contract.
 *
 * The fallback's one residue, and it is irreducible: it orders ties by the
 * **id**. That is what SQL, MongoDB and the file driver order them by outright,
 * and what the memory and Redis drivers order them by too whenever the ids are
 * the generated UUIDv7s, which sort in add order — the very thing their
 * counters count. A caller that supplies its own `jobId`s in an order which
 * disagrees with the order it adds them in breaks that agreement, and then —
 * once the anchor job is **gone** — this step can land at the wrong place
 * among jobs tied on every other field. Two measurements, on a bulk sharing
 * one priority and one creation millisecond with the anchor removed before
 * every page:
 *
 * - **memory**, 12 jobs: **0 lost, 21 repeated**. The id fallback lands
 *   ahead* of where `queue.order` had reached, so the walk re-serves rows
 *   rather than losing them — noisy, and the better side of that trade.
 * - **Redis**, 21 jobs, and only where the job's hash has gone too (its seek
 *   reads the member off the hash first, so merely claiming or completing the
 *   anchor keeps it exact): **16 lost**. That one is silent, and it is the
 *   sharpest thing a caller can do to itself here.
 *
 * Neither is reachable with generated ids, which is the default. A caller that
 * both chooses its own ids *and* chooses them against its add order is asking
 * two backends to order a tie by something no cursor can name.
 */
export function seekJobIndex(
  /** The listing, in the order being walked. */
  ordered: readonly JobRecord[],
  /** Where the previous page stopped. */
  key: JobCursorKey,
  /** The walk's ordering fields. */
  fields: readonly JobOrderField[],
  /** The direction being walked. */
  order: "asc" | "desc",
): number {
  const anchor = ordered.findIndex((record) => record.id === key.id);

  if (anchor !== -1) {
    return anchor + 1;
  }

  const next = ordered.findIndex((record) =>
    isAfterJob(record, key, fields, order),
  );

  return next === -1 ? ordered.length : next;
}

/**
 * Refuses a cursor on a walk that cannot be seeked, with the reason.
 *
 * Raised as a `ConfigError` so it reaches the API as 400 `INVALID_ARGUMENT`,
 * like every other cursor refusal, rather than as a page the client would read
 * as the end of the list.
 */
export function refuseUnseekableWalk(
  /** The states being listed. */
  states: readonly JobState[],
): never {
  throw new ConfigError(
    "`active` cannot be walked with a cursor: its order is `lockExpiresAt`, which every worker rewrites each time it renews a lock, so a cursor there is no more stable than an `offset`. Page `active` with `offset`, or walk it with `sort=createdAt`.",
    { states: [...states] },
  );
}
