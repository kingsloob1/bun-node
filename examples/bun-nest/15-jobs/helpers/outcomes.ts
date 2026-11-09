/**
 * A helper the `15-jobs` examples share (`run-all.ts` skips `helpers/`):
 * waiting for a job to end, and telling how it ended.
 */
import type { BunQueueWorker, Job } from "@kingsleyweb/bun-jobs";
import type { INestApplicationContext } from "@nestjs/common";
import type { WorkerRef } from "@kingsleyweb/bun-nest/jobs";
import { getWorkerToken } from "@kingsleyweb/bun-nest/jobs";

/** How a job ended, or one attempt of it failed, as the worker reported it. */
export interface Outcome {
  /** `"completed"`, `"failed"` (will be retried) or `"dead"` (given up). */
  state: "completed" | "failed" | "dead";
  /** The handler's result, for a completed job. */
  result?: unknown;
  /** The error, for a failed or dead job. */
  error?: Error;
  /** How many attempts had been made when this one ended. */
  attemptsMade: number;
}

/** What {@link watchQueue} returns. */
export interface Watcher {
  /** Resolves when `jobId` is `completed` or `dead` (not merely `failed`, which may retry), or rejects after 10 s. */
  outcome: (jobId: string) => Promise<Outcome>;
  /** Every terminal outcome seen so far, in order, with the job's id. */
  seen: { id: string; outcome: Outcome }[];
  /** Every failed attempt seen so far (a `dead` job fails first, too), in order. */
  failures: { id: string; outcome: Outcome }[];
}

/**
 * Listens to the worker serving `queue` in `app` and records how each job
 * ends. Call it before adding jobs.
 */
export function watchQueue(
  app: INestApplicationContext,
  queue: string,
): Watcher {
  const { worker } = app.get<WorkerRef>(getWorkerToken(queue), {
    strict: false,
  }) as { worker: BunQueueWorker };
  const seen: { id: string; outcome: Outcome }[] = [];
  const failures: { id: string; outcome: Outcome }[] = [];
  const waiters = new Map<string, ((outcome: Outcome) => void)[]>();

  const record = (job: Job, outcome: Outcome) => {
    seen.push({ id: job.id, outcome });
    for (const wake of waiters.get(job.id) ?? []) wake(outcome);
    waiters.delete(job.id);
  };

  worker.on("completed", (job: Job, result: unknown) => {
    record(job, { state: "completed", result, attemptsMade: job.attemptsMade });
  });
  worker.on("failed", (job: Job, error: Error) => {
    failures.push({
      id: job.id,
      outcome: { state: "failed", error, attemptsMade: job.attemptsMade },
    });
  });
  worker.on("dead", (job: Job, error: Error) => {
    record(job, { state: "dead", error, attemptsMade: job.attemptsMade });
  });

  return {
    seen,
    failures,
    outcome: (jobId) =>
      new Promise<Outcome>((resolve, reject) => {
        const earlier = seen.find((entry) => entry.id === jobId);
        if (earlier) return resolve(earlier.outcome);
        const timer = setTimeout(
          () => reject(new Error(`job ${jobId} did not end within 10 s`)),
          10_000,
        );
        waiters.set(jobId, [
          ...(waiters.get(jobId) ?? []),
          (outcome) => {
            clearTimeout(timer);
            resolve(outcome);
          },
        ]);
      }),
  };
}
