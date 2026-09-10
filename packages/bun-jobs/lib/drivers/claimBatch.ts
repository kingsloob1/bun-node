import type { ClaimOptions, JobRecord, QueueDriver, QueueRef } from "./driver";

/**
 * Claiming several jobs at once, whether or not the driver can do it natively.
 *
 * A worker used to claim one job per round trip, which capped drain throughput
 * at one over the claim latency however high its concurrency was — measured on
 * Postgres, 380 jobs/s against graphile-worker's 4,254/s, which batches. Asking
 * for a batch is the fix, but `claimJobs` is **optional** on the driver
 * contract: an external driver is a supported extension point, and a required
 * method would break every third-party implementation. This is the one place
 * that decides which path to take.
 *
 * The batch is **not atomic**. Each returned job is claimed exactly once — that
 * guarantee is unchanged and is what the contract suite checks — but a driver
 * may return fewer than asked for, and a native plural claim may be atomic
 * where the fallback is not. Nothing may depend on all-or-nothing.
 */

/**
 * Claims up to `limit` jobs.
 *
 * Returns fewer than `limit` when the queue runs dry, and an empty array when
 * there was nothing to take. A short result is **not** the same as an empty
 * one: only `length === 0` means the queue had nothing claimable.
 */
export async function claimJobBatch(
  driver: QueueDriver,
  q: QueueRef,
  opts: ClaimOptions,
  limit: number,
): Promise<JobRecord[]> {
  // One job is the common case on an idle queue, and it is the case the
  // round-trip latency benchmark measures. A native plural path can be more
  // expensive than the singular one it is built from — on MongoDB it is three
  // round trips against one — so a batch of one never takes it.
  if (limit <= 1) {
    const single = await driver.claimJob(q, opts);
    return single ? [single] : [];
  }

  if (driver.claimJobs) {
    return await driver.claimJobs(q, opts, limit);
  }

  return await claimByLoop(async () => await driver.claimJob(q, opts), limit);
}

/**
 * Claims up to `limit` jobs by asking for one at a time.
 *
 * The fallback for a driver with no plural claim, and also the path a driver
 * takes for an engine whose plural claim would be no better than the loop —
 * MySQL holds a row lock per row for the whole batch, so a wide one is slower,
 * not faster.
 */
export async function claimByLoop(
  claimOne: () => Promise<JobRecord | null>,
  limit: number,
): Promise<JobRecord[]> {
  const claimed: JobRecord[] = [];

  try {
    // Sequential, deliberately. Issuing these concurrently would be faster and
    // would lose the claim order: each call independently races for the head of
    // the queue, and `SKIP LOCKED` hands each racer a different row.
    while (claimed.length < limit) {
      const job = await claimOne();

      // The queue is dry. Asking again would cost a round trip per remaining
      // slot for nothing.
      if (!job) {
        break;
      }

      claimed.push(job);
    }
  } catch (error) {
    // Whatever is already in `claimed` is `active` in the backend with the
    // caller's token on it. Throwing would abandon those jobs to the stalled
    // sweep — up to `lockDuration + stalledInterval` later, and a stall each,
    // when `maxStalledCount` defaults to 1. A transient blip must not half-kill
    // a batch, so the caller gets what was actually taken.
    //
    // The error is not lost: the next pass claims nothing and surfaces it then,
    // with no jobs at risk.
    if (claimed.length === 0) {
      throw error;
    }
  }

  return claimed;
}
