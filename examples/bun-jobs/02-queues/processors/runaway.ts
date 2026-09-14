/**
 * A processor that misbehaves: it spins the CPU and never looks at its
 * signal. In-process it would freeze the worker's thread — its claim loop,
 * its heartbeats, every other job. Used by `02-queues/isolated-processors.ts`
 * to show that in a child process it can still be stopped.
 */
import { defineProcessor } from "@kingsleyweb/bun-jobs";

export default defineProcessor<{ spinMs: number }, string>((job) => {
  const until = Date.now() + job.data.spinMs;

  // Deliberately synchronous: nothing else on this thread runs until it ends.
  while (Date.now() < until) {
    // spin
  }

  return "finished spinning";
});
