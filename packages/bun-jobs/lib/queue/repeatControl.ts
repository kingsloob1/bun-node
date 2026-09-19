import type {
  JobRecord,
  JobsDriver,
  QueueRef,
  RepeatRecord,
} from "../drivers/index";
import { NotSupportedError } from "../shared/errors";
import { fitName } from "../shared/fit";
import {
  CALLER_REPEAT_KEY_PREFIX,
  DERIVED_NAME_LIMITS,
  displayRepeatKey,
  shortenJobId,
} from "./options";
import { nextOccurrence, repeatJobId } from "./repeat";
import { RESERVED_STATE_PREFIX, setReservedState } from "./windows";

/**
 * Disabling and enabling a repeat series.
 *
 * A disabled series keeps its definition — its schedule, its count, its key —
 * and loses only its future: the pending occurrence is removed, and nothing
 * schedules another until it is enabled. The flag is a queue-state entry under
 * the prefix this package reserves, written with the private token, so no
 * caller's `setQueueState` can set or clear it by accident.
 *
 * Every worker checks the flag before scheduling a series' next occurrence,
 * and maintenance removes a pending occurrence a disabled series still has.
 * So the one race left is the occurrence already running when the series is
 * disabled: it finishes, and at most the one a worker was scheduling at that
 * instant is added and then removed by the next maintenance pass.
 */

/** The prefix of every disabled series' flag in queue state. */
export const REPEAT_DISABLED_PREFIX = `${RESERVED_STATE_PREFIX}repeat-disabled:`;

/** What a disabled series' flag holds. */
export interface RepeatDisabledFlag {
  /** When it was disabled, in epoch milliseconds. */
  at: number;
}

/**
 * The queue-state name of `storedKey`'s disabled flag, fitted like any name
 * this package derives so a key of the longest legal length still makes a
 * storable name.
 */
export function repeatDisabledName(storedKey: string): string {
  return fitName(`${REPEAT_DISABLED_PREFIX}${storedKey}`, DERIVED_NAME_LIMITS);
}

/** Whether a driver can store the flag: it has queue state. */
export function supportsRepeatControl(driver: JobsDriver): boolean {
  return (
    typeof driver.getQueueState === "function" &&
    typeof driver.setQueueState === "function"
  );
}

/**
 * Whether the series stored as `storedKey` is disabled. Always `false` on a
 * driver without queue state, which cannot disable one.
 */
export async function isRepeatDisabled(
  driver: JobsDriver,
  q: QueueRef,
  storedKey: string,
): Promise<boolean> {
  if (!supportsRepeatControl(driver)) {
    return false;
  }

  return (
    (await driver.getQueueState!(q, repeatDisabledName(storedKey))) !== null
  );
}

/**
 * Finds a series by either spelling of its key — as `listRepeatables()`
 * reports it, or as the caller gave it to `repeat.key`, which is stored
 * namespaced — and answers with its stored definition, or `null`.
 *
 * The listed spelling is matched first, and only a stored series that
 * _displays_ as `key` counts. Looking the raw key up first was wrong: a caller
 * key of `k:nightly` is stored as `k:k:nightly` and listed as `k:nightly`,
 * while `k:nightly` is also the stored spelling of the series keyed `nightly`
 * — so acting on the one listed acted on the other.
 */
export async function findRepeat(
  driver: JobsDriver,
  q: QueueRef,
  key: string,
): Promise<RepeatRecord | null> {
  const stored = [key, `${CALLER_REPEAT_KEY_PREFIX}${key}`];

  for (const candidate of stored) {
    const found = await driver.getRepeat(q, candidate);
    if (found && displayRepeatKey(found.key) === key) {
      return found;
    }
  }

  // Then the spelling the caller originally supplied, for a key containing
  // `|`, whose prefix stays visible when listed.
  return await driver.getRepeat(q, stored[1]!);
}

/**
 * Disables the series stored as `storedKey`, removing its pending
 * occurrence and clearing its `nextRunAt`/`nextJobId`. Answers whether this
 * call disabled it: `false` for a series that is gone or already disabled.
 *
 * `needs` names the method the caller called — `disable()` on a job,
 * `disableRepeatable()` on a queue — for the `NotSupportedError` a driver
 * without queue state raises.
 */
export async function disableRepeatSeries(
  driver: JobsDriver,
  q: QueueRef,
  storedKey: string,
  now: number,
  needs: string,
): Promise<boolean> {
  requireRepeatControl(driver, needs);

  const definition = await driver.getRepeat(q, storedKey);
  if (!definition) {
    return false;
  }

  const flag: RepeatDisabledFlag = { at: now };
  const written = await setReservedState(
    driver,
    q,
    repeatDisabledName(storedKey),
    flag,
    null,
  );

  // Already there: disabled before, or by a caller racing this one.
  if (written === null) {
    return false;
  }

  // Read again now the flag is set, so the occurrence removed is the one
  // pointed to at this moment, not before.
  const current = (await driver.getRepeat(q, storedKey)) ?? definition;
  await removePendingOccurrence(driver, q, current);

  // A disabled series has no next occurrence, and its record says so. Only
  // while it still points where it did: a worker that scheduled one past the
  // flag in the last instant has moved the pointer, and keeping it lets
  // maintenance find and remove that occurrence.
  const latest = await driver.getRepeat(q, storedKey);
  if (latest && latest.nextJobId === current.nextJobId) {
    await driver.upsertRepeat(q, {
      ...latest,
      nextRunAt: null,
      nextJobId: null,
      updatedAt: now,
    });
  }

  return true;
}

/**
 * Enables the series stored as `storedKey`, scheduling its next occurrence
 * from `now` — nothing it missed while disabled is run. Answers whether this
 * call enabled it: `false` for a series that was not disabled.
 *
 * `needs` names the method the caller called, as for
 * {@link disableRepeatSeries}.
 */
export async function enableRepeatSeries(
  driver: JobsDriver,
  q: QueueRef,
  storedKey: string,
  now: number,
  needs: string,
): Promise<boolean> {
  requireRepeatControl(driver, needs);

  const name = repeatDisabledName(storedKey);
  const entry = await driver.getQueueState!(q, name);

  if (!entry) {
    return false;
  }

  // Cleared at the version read, so of two callers enabling at once exactly
  // one schedules the next occurrence.
  if ((await setReservedState(driver, q, name, null, entry.version)) === null) {
    return false;
  }

  const definition = await driver.getRepeat(q, storedKey);
  if (definition) {
    await scheduleFromNow(driver, q, definition, now);
  }

  return true;
}

/**
 * Clears the series' disabled flag, if it has one, whatever its version.
 * What removing a series does, so a series added again under the same key
 * starts enabled.
 */
export async function clearRepeatDisabled(
  driver: JobsDriver,
  q: QueueRef,
  storedKey: string,
): Promise<void> {
  if (!supportsRepeatControl(driver)) {
    return;
  }

  const name = repeatDisabledName(storedKey);

  for (let attempt = 0; attempt < 5; attempt++) {
    const entry = await driver.getQueueState!(q, name);
    if (
      !entry ||
      (await setReservedState(driver, q, name, null, entry.version)) !== null
    ) {
      return;
    }
  }
}

/**
 * Removes a series' pending occurrence — only while it is still pending: one
 * a worker has claimed runs to the end, and one that has finished is its
 * history, not its future.
 */
export async function removePendingOccurrence(
  driver: JobsDriver,
  q: QueueRef,
  definition: RepeatRecord,
): Promise<boolean> {
  if (!definition.nextJobId) {
    return false;
  }

  const pending = await driver.getJob(q, definition.nextJobId);
  if (
    !pending ||
    pending.repeatKey !== definition.key ||
    (pending.state !== "waiting" && pending.state !== "delayed")
  ) {
    return false;
  }

  return await driver.removeJob(q, pending.id);
}

/**
 * The job record of `definition`'s occurrence due at `runAt`, as every site
 * that schedules one builds it — its id derived from the series and the time,
 * which is what lets several of them converge on one job.
 */
export function occurrenceRecord(
  definition: RepeatRecord,
  runAt: number,
  now: number,
): JobRecord {
  return {
    id: shortenJobId(repeatJobId(displayRepeatKey(definition.key), runAt)),
    name: definition.name,
    data: definition.data,
    opts: definition.opts,
    state: runAt > now ? "delayed" : "waiting",
    priority: definition.opts.priority,
    runAt,
    createdAt: now,
    processedOn: null,
    finishedOn: null,
    expiresAt: null,
    attemptsMade: 0,
    maxAttempts: definition.opts.attempts,
    stalledCount: 0,
    progress: null,
    returnValue: null,
    failedReason: null,
    stacktrace: [],
    lockToken: null,
    lockExpiresAt: null,
    workerId: null,
    repeatKey: definition.key,
    flow: null,
  };
}

/**
 * Schedules a re-enabled series' next occurrence from `now`, unless one is
 * still pending — left by a worker that scheduled it just as the series was
 * disabled, and not yet swept.
 */
async function scheduleFromNow(
  driver: JobsDriver,
  q: QueueRef,
  definition: RepeatRecord,
  now: number,
): Promise<void> {
  if (definition.nextJobId) {
    const pending = await driver.getJob(q, definition.nextJobId);
    if (
      pending &&
      (pending.state === "waiting" || pending.state === "delayed")
    ) {
      return;
    }
  }

  const next = nextOccurrence(definition, now);

  if (next === null) {
    await driver.upsertRepeat(q, {
      ...definition,
      nextRunAt: null,
      nextJobId: null,
      updatedAt: now,
    });
    return;
  }

  const record = occurrenceRecord(definition, next, now);
  await driver.addJob(q, record);
  await driver.upsertRepeat(q, {
    ...definition,
    nextRunAt: next,
    nextJobId: record.id,
    updatedAt: now,
  });
}

/**
 * The driver, checked to have the queue state a disabled flag lives in;
 * otherwise a `NotSupportedError` whose `needs` is `what`, the method called.
 */
export function requireRepeatControl(driver: JobsDriver, what: string): void {
  if (!supportsRepeatControl(driver)) {
    throw new NotSupportedError(driver.name, "setQueueState", { needs: what });
  }
}
