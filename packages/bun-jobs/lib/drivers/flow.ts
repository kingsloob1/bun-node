import type { JobFlow, JobRecord, JobRef } from "./driver";

/**
 * Small pieces of the flow contract every driver and the worker share, kept in
 * one place so the key format and the retention guard cannot drift apart.
 *
 * Internal: not exported from the package.
 */

/** The key a child's outcome is stored under on its parent: `queue:id`. */
export function flowKey(ref: JobRef): string {
  return `${ref.queue}:${ref.id}`;
}

/**
 * Whether a job is a child in a flow whose outcome its parent has not recorded
 * yet. Retention — a count sweep, a TTL — must leave such a job alone, or the
 * outcome is lost before it is delivered.
 */
export function awaitsDelivery(
  record: Pick<JobRecord, "flow"> | { flow?: JobFlow | null },
): boolean {
  return Boolean(record.flow?.parent) && record.flow?.recorded !== true;
}

/** Whether `flow` lists `child` among its children. */
export function listsChild(flow: JobFlow, child: JobRef): boolean {
  return flow.children.some(
    (ref) => ref.queue === child.queue && ref.id === child.id,
  );
}

/** How many of a flow's children have no outcome recorded on it. */
export function unsettledChildren(flow: JobFlow): number {
  let pending = 0;

  for (const child of flow.children) {
    const key = flowKey(child);
    if (
      !Object.hasOwn(flow.values, key) &&
      !Object.hasOwn(flow.failures, key)
    ) {
      pending++;
    }
  }

  return pending;
}
