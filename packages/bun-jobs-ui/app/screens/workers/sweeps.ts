import type { WorkerDto } from "../../api/types";

/**
 * Whether a queue's live workers leave its housekeeping to nobody.
 *
 * `WorkerDto.sweeps` says whether a worker takes part in the queue's minute
 * pass — pruning expired results, healing repeat series, sweeping stale queue
 * state — which its `maintenance` option decides. It says nothing about
 * liveness: promoting delayed jobs, recovering stalled ones and healing flows
 * happen on every worker and cannot be turned off, so a queue nobody sweeps
 * still runs. It only accumulates what nobody tidies.
 *
 * **The verb is queue-level on purpose.** Once the pass is leased (bun-jobs
 * #108), one `sweeps: true` worker holds the lease per pass and the rest stand
 * down, so saying a *worker* "runs the sweeps" is wrong most of the time —
 * `true` is a capability, never a live activity, and a per-worker label must
 * read "takes part in housekeeping". Of a *queue* the plainer verb stays
 * exactly true: if nobody arms the timer, nobody contends, and nothing is
 * swept. That is why the note below says "no live worker … runs housekeeping"
 * rather than making an operator parse a lease to learn their expired jobs are
 * piling up.
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
