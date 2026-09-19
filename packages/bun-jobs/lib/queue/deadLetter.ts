import type { SerializedError } from "@kingsleyweb/bun-common";
import type { JobRecord, JobsDriver } from "../drivers/index";
import type { BunQueue } from "./BunQueue";
import type { Job } from "./Job";
import type { DeadLetter } from "./types";
import { ConfigError } from "../shared/errors";
import { shortenJobId } from "./options";

/**
 * Filing a dead job's copy in its dead-letter queue — shared by the worker,
 * for a job that died running, and by `Job.fail()`, for one buried from
 * outside.
 */

/** A queue dead letters are added to. */
export type DeadLetterQueue = BunQueue<DeadLetter, unknown, string>;

/**
 * The refusal to file a letter in the queue the job died in, or `undefined`
 * when `target` is another queue. A letter to itself would be claimed, fail,
 * and file another.
 */
export function selfLetterError(
  target: string,
  source: string,
  record: JobRecord,
): ConfigError | undefined {
  return target === source
    ? new ConfigError(
        `Job ${record.id} names its own queue "${target}" as its dead-letter queue`,
        { jobId: record.id, queue: target },
      )
    : undefined;
}

/**
 * Adds a copy of a dead job to `queue`.
 *
 * After the job is marked dead, never before: a crash between the two leaves
 * a dead job with no letter, which is visible and re-drivable, rather than a
 * letter for a job that is about to be retried. The letter's id is derived
 * from the job's, so a death noticed twice files one letter — and from its
 * creation time too, so a later job reusing the id files its own.
 */
export async function addDeadLetter(
  queue: DeadLetterQueue,
  source: string,
  record: JobRecord,
  error: SerializedError,
  now: number,
): Promise<Job<DeadLetter, unknown>> {
  return await queue.add(
    record.name,
    {
      queue: source,
      id: record.id,
      name: record.name,
      data: record.data,
      failedReason: error,
      attemptsMade: record.attemptsMade,
      diedAt: now,
    },
    // Shortened, never refused. This runs on the failure path, so a job
    // whose own id is legal but near the limit must not throw here — that
    // would lose the letter for the one job that most needed filing.
    { jobId: shortenJobId(`${source}:${record.id}:${record.createdAt}`) },
  );
}

/**
 * Files the letter of a job buried from outside its processor, in the queue
 * its own `deadLetter` option names — the worker's `deadLetterQueue` belongs
 * to the worker, and none is involved. Nothing, when the job names none.
 *
 * The queue is opened for this one letter and closed after; it shares the
 * caller's driver, which it does not own and so leaves open.
 */
export async function fileBuriedLetter(
  driver: JobsDriver,
  ns: string,
  source: string,
  record: JobRecord,
  error: SerializedError,
  now: number,
): Promise<Job<DeadLetter, unknown> | undefined> {
  const target = record.opts.deadLetter;
  if (target === undefined) {
    return undefined;
  }

  const refused = selfLetterError(target, source, record);
  if (refused) {
    throw refused;
  }

  // Imported here rather than at the top: `BunQueue` imports `Job`, which
  // imports this module.
  const { BunQueue } = await import("./BunQueue");
  const queue: DeadLetterQueue = new BunQueue<DeadLetter, unknown, string>(
    target,
    { namespace: ns, driver },
  );

  try {
    return await addDeadLetter(queue, source, record, error, now);
  } finally {
    await queue.close();
  }
}
