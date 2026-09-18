import type { JobsDriver, QueueRef } from "../drivers/index";
import { ConfigError } from "../shared/errors";

/**
 * The stored pointers behind debounce and throttle, and how the ones whose
 * purpose has passed are removed.
 *
 * Each debounced or throttled id keeps one entry in queue state: the job that
 * currently stands for it. An entry is needed only for a while — a debounce
 * pointer until its job starts, a throttle pointer until its window closes —
 * but nothing about a job finishing or a window passing touches the entry,
 * so without a sweep there would be one left behind for every id ever used.
 *
 * Removal is a compare-and-set delete at the version that was judged stale. A
 * producer that moves the pointer in the meantime bumps the version, the
 * delete does nothing, and the producer's pointer survives.
 */

/**
 * The prefix this package reserves in queue state for its own entries.
 *
 * Window pointers used to be named `debounce:<id>` / `throttle:<id>`, which is
 * a name an application could choose too — and the sweep, seeing a name it
 * believed it owned, **deleted it**. Anything under this prefix is the
 * library's; everything else belongs to the caller and is never touched.
 */
export const RESERVED_STATE_PREFIX = "__win:";

/** The prefix of every debounce pointer's name. */
export const DEBOUNCE_PREFIX = `${RESERVED_STATE_PREFIX}debounce:`;

/** The prefix of every throttle pointer's name. */
export const THROTTLE_PREFIX = `${RESERVED_STATE_PREFIX}throttle:`;

/**
 * The token a library write to a reserved name carries.
 *
 * Deliberately never exported, and a `symbol` rather than a flag: a public
 * `{ internal: true }` was a bypass anyone could type. Only
 * {@link setReservedState} can attach it, and only
 * {@link assertWritableStateName} can recognise it.
 */
const INTERNAL_WRITE = Symbol("bun-jobs: reserved queue-state write");

/** What {@link setReservedState} passes to `setQueueState`. */
const INTERNAL_WRITE_OPTIONS = Object.freeze({ internal: INTERNAL_WRITE });

/**
 * Refuses a caller's write to a name this package reserves.
 *
 * The prefix move already stops the sweep from deleting an application's
 * entries; this stops the reverse — an application writing over a pointer and
 * confusing the sweep. Only a write made through {@link setReservedState}
 * gets through, and that is checked here, at the driver, against a token no
 * caller can obtain. A driver passes on the `options` its `setQueueState` was
 * given, untouched.
 */
export function assertWritableStateName(
  name: string,
  options?: { internal?: symbol },
): void {
  if (
    options?.internal !== INTERNAL_WRITE &&
    name.startsWith(RESERVED_STATE_PREFIX)
  ) {
    throw new ConfigError(
      `Queue state names beginning with "${RESERVED_STATE_PREFIX}" are reserved by bun-jobs; choose another name`,
      { name, reserved: RESERVED_STATE_PREFIX },
    );
  }
}

/**
 * Writes one of this package's own queue-state entries, which a caller's
 * `setQueueState` may not. Same contract as `setQueueState`.
 *
 * Internal: not re-exported from the package.
 */
export async function setReservedState(
  driver: JobsDriver,
  q: QueueRef,
  name: string,
  value: unknown,
  expected: number | null,
): Promise<number | null> {
  return await driver.setQueueState!(
    q,
    name,
    value,
    expected,
    INTERNAL_WRITE_OPTIONS,
  );
}

/** A debounce pointer, as stored. */
export interface DebouncePointer {
  /** The job debounced adds go into while it is pending. */
  jobId: string;
  /**
   * When the pointer was written, in epoch milliseconds. Absent on a pointer
   * written before this field existed, which is read as long past.
   */
  at?: number;
  /**
   * Whether {@link jobId} names a job that has actually been written.
   *
   * A producer moves the pointer *before* adding the job, so between the two
   * the pointer names a job that does not exist yet. That is indistinguishable
   * from a pointer whose job has since been removed unless the pointer says
   * so, and treating the one as the other is what let a sweep — or a second
   * producer — delete a live window and leave two jobs where the caller asked
   * for one. Set by a second compare-and-set once the job is there.
   *
   * Absent on a pointer written before this field existed, which is read as
   * confirmed so those keep behaving exactly as they did.
   */
  ready?: boolean;
}

/** A throttle pointer, as stored. */
export interface ThrottlePointer {
  /** The job that opened the window. */
  jobId: string;
  /** When the window closes, in epoch milliseconds. */
  until: number;
}

/** What one sweep did, and where the next should resume. */
export interface WindowSweep {
  /** How many stale pointers were removed. */
  removed: number;
  /** The last name examined, to pass back as `after`; `undefined` at the end. */
  next: string | undefined;
}

/**
 * How long a debounce pointer may name a job that does not exist yet before it
 * is treated as abandoned rather than in flight.
 *
 * Generous on purpose: the only cost of being too patient is that a pointer
 * left by a producer that died mid-add survives this much longer, while being
 * too hasty deletes a live window and duplicates a job. It is compared against
 * a clock that may be another process's, so it also has to absorb ordinary
 * clock skew.
 */
export const WINDOW_PENDING_MS = 30_000;

/**
 * Whether a debounce pointer's job may still be on its way to the backend —
 * the pointer has not been confirmed, and was written recently enough that the
 * producer that wrote it could still be adding.
 *
 * A pointer from before {@link DebouncePointer.at} existed has no timestamp,
 * reads as long past, and is therefore never pending.
 */
export function debounceIsPending(
  pointer: DebouncePointer,
  now: number,
): boolean {
  return pointer.ready !== true && now - (pointer.at ?? 0) <= WINDOW_PENDING_MS;
}

/** Whether a driver can list, read and conditionally delete queue state. */
export function supportsWindowSweep(driver: JobsDriver): boolean {
  return (
    typeof driver.listQueueState === "function" &&
    typeof driver.getQueueState === "function" &&
    typeof driver.setQueueState === "function"
  );
}

/**
 * Examines up to `limit` state entries after `after`, and removes the
 * debounce and throttle pointers among them that no longer stand for
 * anything. Other entries — limits, the limiter's counters — are passed over.
 *
 * Bounded per call; a caller covering everything passes `next` back in until
 * it comes back `undefined`.
 */
export async function sweepWindows(
  driver: JobsDriver,
  q: QueueRef,
  options: {
    /** The caller's clock. */
    now: number;
    /** How many entries to examine. */
    limit: number;
    /** Resume after this name. */
    after?: string;
  },
): Promise<WindowSweep> {
  const names = await driver.listQueueState!(q, {
    prefix: "",
    limit: options.limit,
    ...(options.after !== undefined ? { after: options.after } : {}),
  });

  let removed = 0;

  for (const name of names) {
    const isDebounce = name.startsWith(DEBOUNCE_PREFIX);
    const isThrottle = name.startsWith(THROTTLE_PREFIX);

    if (!isDebounce && !isThrottle) {
      continue;
    }

    const entry = await driver.getQueueState!(q, name);

    if (!entry) {
      continue;
    }

    const stale = isDebounce
      ? await debounceIsStale(
          driver,
          q,
          entry.value as DebouncePointer,
          options.now,
        )
      : ((entry.value as ThrottlePointer).until ?? 0) <= options.now;

    if (
      stale &&
      (await setReservedState(driver, q, name, null, entry.version)) === 0
    ) {
      removed++;
    }
  }

  return {
    removed,
    next: names.length < options.limit ? undefined : names.at(-1),
  };
}

/**
 * Whether a debounce pointer can go: its job is gone, or has started. A later
 * add would replace either anyway, so removing it changes nothing a producer
 * can observe.
 *
 * With one exception, which is the whole reason {@link DebouncePointer.ready}
 * exists: no job *yet* is not the same as no job. A producer writes the
 * pointer and then adds the job, and for that moment there is nothing to
 * find — so a pointer still {@link debounceIsPending} is left alone. Deleting
 * it here let the next add open a second window, and the caller got two jobs.
 */
async function debounceIsStale(
  driver: JobsDriver,
  q: QueueRef,
  pointer: DebouncePointer,
  now: number,
): Promise<boolean> {
  const job = await driver.getJob(q, pointer.jobId);

  if (!job) {
    return !debounceIsPending(pointer, now);
  }

  return job.state !== "waiting" && job.state !== "delayed";
}
