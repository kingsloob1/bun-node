import type { JobsDriver, QueueRef } from "../drivers/index";
import { ConfigError } from "../shared/errors";

/**
 * Retries one job, the way every public retry does — `BunQueue.retry`,
 * `retryJobs`, `retryAll` and `Job.retry`.
 *
 * A parent that a child's failure buried goes back to waiting on the children
 * it has no outcome for, through `requeueParent`, rather than to `waiting`
 * through `retryJob`, which would run it without them. Retry the failed child
 * as well and the parent runs once it completes — in either order: a child
 * that completes while its parent is still buried has its result kept there.
 *
 * The count of children left is taken by the driver, in the same atomic step
 * as the move, so an outcome recorded in between is never counted twice.
 *
 * Internal: kept in one place so no retry path can bypass the flow check.
 */
export async function retryJob(
  driver: JobsDriver,
  ref: QueueRef,
  id: string,
  resetAttempts: boolean,
  now: number,
): Promise<boolean> {
  const record = await driver.getJob(ref, id);
  const flow = record?.flow;

  if (record?.state === "dead" && flow && flow.children.length > 0) {
    if (typeof driver.requeueParent !== "function") {
      throw new ConfigError(
        `retrying a flow parent needs a driver that implements requeueParent, and the ${driver.name} driver does not`,
        { driver: driver.name, method: "requeueParent" },
      );
    }

    return await driver.requeueParent(ref, id, now);
  }

  return await driver.retryJob(ref, id, resetAttempts, now);
}
