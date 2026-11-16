/**
 * The race both sides of the store kit's two-process pass run: the kit's
 * own side in the test process, the other in `crossprocess-worker.ts`.
 */
import type { SecurityStoreDriver } from "../store/types";
import type { StoreCrossProcessJob } from "./crossprocess-worker";

/** What the worker won. */
export interface StoreCrossProcessResult {
  /** The revisions its writes produced. */
  readonly revisions: number[];
  /** The version ids its appends added. */
  readonly versions: string[];
}

/**
 * Wins `count` writes of one document and `count` appends to one policy,
 * each read-then-compare-and-set, retried on a refusal. The kit's own side
 * runs the same function.
 */
export async function raceStore(
  store: SecurityStoreDriver,
  job: Pick<StoreCrossProcessJob, "docId" | "policyId" | "count" | "side">,
): Promise<StoreCrossProcessResult> {
  const revisions: number[] = [];
  const versions: string[] = [];
  while (revisions.length < job.count) {
    const current = await store.get("service", job.docId);
    const result = await store.put(
      "service",
      job.docId,
      { side: job.side, at: revisions.length },
      current?.revision ?? null,
    );
    if (result.ok) revisions.push(result.revision);
    await Bun.sleep(0);
  }
  while (versions.length < job.count) {
    const head = await store.get("policy", job.policyId);
    const id = `${job.side}-${versions.length}`;
    const result = await store.appendVersion(
      job.policyId,
      { id, policy: { side: job.side } },
      head === undefined ? null : (head.doc as { head: string }).head,
    );
    if (result.ok) versions.push(id);
    await Bun.sleep(0);
  }
  return { revisions, versions };
}
