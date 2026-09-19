import { defineProcessor } from "../../../lib/index";

/**
 * Reports the job's read-only members as the processor sees them, through
 * `updateProgress`, so a test can hold them against the worker's own `Job`
 * for the same attempt. Errors are reduced to their messages to cross the
 * boundary as JSON.
 */
export default defineProcessor(async (job) => {
  await job.updateProgress({
    id: job.id,
    name: job.name,
    data: job.data as Record<string, unknown>,
    opts: job.opts as unknown as Record<string, unknown>,
    state: job.state,
    priority: job.priority,
    runAt: job.runAt,
    createdAt: job.createdAt,
    processedOn: job.processedOn,
    finishedOn: job.finishedOn,
    expiresAt: job.expiresAt,
    attemptsMade: job.attemptsMade,
    maxAttempts: job.maxAttempts,
    stalledCount: job.stalledCount,
    progress: job.progress as number | null,
    returnValue: job.returnValue as number | null,
    failedReason: job.failedReason?.message ?? null,
    stacktrace: job.stacktrace.map((error) => error.message),
    workerId: job.workerId,
    repeatKey: job.repeatKey,
    wasAdded: job.wasAdded,
    queue: { ...job.queue },
    isRepeat: job.isRepeat,
    lockToken: job.lockToken,
    parent: job.parent,
  });
  return null;
});
