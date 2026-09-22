import type { JobRecord, JobsDriver, QueueRef } from "../drivers/index";
import { flowKey } from "../drivers/flow";
import { ChildFailedError, ConfigError } from "../shared/errors";

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

    await markBuryDelivered(driver, ref, record, now);
    return await driver.requeueParent(ref, id, now);
  }

  return await driver.retryJob(ref, id, resetAttempts, now);
}

/**
 * Marks the child whose failure buried `parent` as recorded, if its worker has
 * not got that far yet, so the failure cannot bury the parent a second time
 * once it is waiting again.
 *
 * Delivering a failure is two writes: the parent is buried, then the child is
 * marked recorded. Between them the parent already reads `dead`, and a retry
 * landing there used to put it back to waiting on a child that was still dead
 * and unrecorded — exactly what maintenance takes for a failure never
 * delivered. It delivered it again, the parent was buried again, and when the
 * retried child then completed its result went to a dead parent, which never
 * ran. The mark is repeat-safe, so the worker making it again afterwards
 * changes nothing; it applies the child's `removeOnFail` as that worker would.
 */
async function markBuryDelivered(
  driver: JobsDriver,
  ref: QueueRef,
  parent: JobRecord,
  now: number,
): Promise<void> {
  const reason = parent.failedReason;
  const burying = reason?.name === ChildFailedError.name && reason.data?.child;
  const child =
    typeof burying === "string"
      ? parent.flow?.children.find((each) => flowKey(each) === burying)
      : undefined;

  if (!child || typeof driver.markChildRecorded !== "function") {
    return;
  }

  const childRef: QueueRef = { ns: ref.ns, queue: child.queue };
  const stored = await driver.getJob(childRef, child.id);

  if (
    stored?.state !== "dead" ||
    stored.flow?.recorded === true ||
    stored.flow?.parent?.queue !== ref.queue ||
    stored.flow.parent.id !== parent.id
  ) {
    return;
  }

  await driver.markChildRecorded(
    childRef,
    child.id,
    stored.opts.removeOnFail,
    now,
  );
}
