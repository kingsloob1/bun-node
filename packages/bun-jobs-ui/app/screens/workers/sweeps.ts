import type { WorkerDto } from "../../api/types";

/**
 * Whether a queue's live workers leave its housekeeping to nobody.
 *
 * `WorkerDto.sweeps` says whether a worker runs the queue's minute pass —
 * pruning expired results, healing repeat series, sweeping stale queue state
 * — which its `maintenance` option decides. It says nothing about liveness:
 * promoting delayed jobs, recovering stalled ones and healing flows happen on
 * every worker and cannot be turned off, so a queue nobody sweeps still runs.
 * It only accumulates what nobody tidies.
 *
 * **Absent is not `false`.** A worker too old to report the field has said
 * nothing, so a queue whose live workers all omit it must not be warned
 * about: otherwise every fleet mid-upgrade reads as broken the moment this UI
 * is deployed against older workers.
 */

/** What the panel says when a queue's housekeeping has no taker. */
export interface SweepWarning {
  /** The sentence to show. */
  message: string;
  /**
   * Whether some live worker is too old to say. The warning is then a
   * possibility rather than a certainty: an older worker may be sweeping
   * unseen.
   */
  uncertain: boolean;
}

/** Said whatever the certainty: the queue is untidy, not stuck. */
const CONSEQUENCE =
  "Jobs still run — delayed jobs are promoted and stalled ones recovered — but expired results, repeat series and stale queue state are not swept.";

/**
 * The warning for a queue's live workers, or `null` when there is nothing to
 * say — some worker sweeps, nobody has reported either way, or there are no
 * workers at all.
 *
 * @param workers The queue's live workers, as `GET /queues/:queue/workers`
 *   returns them.
 */
export function sweepWarning(
  workers: readonly WorkerDto[],
): SweepWarning | null {
  const reported = workers.filter((worker) => worker.sweeps !== undefined);
  // Nobody has said anything: an older fleet, not a misconfigured one.
  if (reported.length === 0) {
    return null;
  }
  if (reported.some((worker) => worker.sweeps === true)) {
    return null;
  }
  const uncertain = reported.length < workers.length;
  return {
    message: uncertain
      ? `No live worker on this queue reports that it runs housekeeping, and some are too old to say — so there may be nobody doing it. ${CONSEQUENCE}`
      : `No live worker on this queue runs housekeeping. ${CONSEQUENCE}`,
    uncertain,
  };
}
