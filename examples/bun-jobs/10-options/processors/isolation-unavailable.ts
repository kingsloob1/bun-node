/**
 * Tries job operations that change the stored job directly, and returns what
 * each one said.
 *
 * In a child process or a `Worker` the driver stays in the worker, so each of
 * these rejects, saying so. In-process the job is the real `Job` and they
 * work. Run by `worker-isolation.ts`; not meant to be run on its own.
 */
import { defineProcessor } from "@kingsleyweb/bun-jobs";

/** What an unavailable-operations job carries. */
export interface UnavailableData {
  /** The `Job` methods to try, by name, in order. */
  methods: string[];
}

/** Each operation tried, and the error message it rejected with, or `"ok"`. */
export type Unavailable = Record<string, string>;

export default defineProcessor<UnavailableData, Unavailable>(async (job) => {
  const attempts: Record<string, () => Promise<unknown>> = {
    updateData: async () => await job.updateData({ methods: [] }),
    setPriority: async () => await job.setPriority(5),
    reschedule: async () => await job.reschedule(Date.now() + 60_000),
    remove: async () => await job.remove(),
    retry: async () => await job.retry(),
    promote: async () => await job.promote(),
    refresh: async () => await job.refresh(),
    getLogs: async () => await job.getLogs(),
  };

  const outcome: Unavailable = {};

  for (const method of job.data.methods) {
    try {
      await attempts[method]?.();
      outcome[method] = "ok";
    } catch (error) {
      outcome[method] = (error as Error).message;
    }
  }

  return outcome;
});
