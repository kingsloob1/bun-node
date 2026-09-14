import type { JobsDriver, QueueRef } from "../drivers/index";

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

/** The prefix of every debounce pointer's name. */
export const DEBOUNCE_PREFIX = "debounce:";

/** The prefix of every throttle pointer's name. */
export const THROTTLE_PREFIX = "throttle:";

/** A debounce pointer, as stored. */
export interface DebouncePointer {
  /** The job debounced adds go into while it is pending. */
  jobId: string;
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
      ? await debounceIsStale(driver, q, entry.value as DebouncePointer)
      : ((entry.value as ThrottlePointer).until ?? 0) <= options.now;

    if (
      stale &&
      (await driver.setQueueState!(q, name, null, entry.version)) === 0
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
 */
async function debounceIsStale(
  driver: JobsDriver,
  q: QueueRef,
  pointer: DebouncePointer,
): Promise<boolean> {
  const job = await driver.getJob(q, pointer.jobId);
  return !job || (job.state !== "waiting" && job.state !== "delayed");
}
