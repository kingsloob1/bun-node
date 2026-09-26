import { writeFileSync } from "node:fs";
import process from "node:process";
import { defineProcessor } from "../../../lib/index";

/**
 * A well-behaved processor: runs until it is asked to stop, then cleans up and
 * returns. What `worker.close()` must give the time to do so.
 *
 * Like `job-spin-report`, it writes its own pid and its parent's to `pidFile`
 * before anything else, so a test knows exactly which process it is. Asked to
 * stop, it spends `cleanupMs` on its cleanup, then writes `markerFile`. Its
 * `exit` handler writes `exitFile`: a process ended by `SIGKILL` runs no
 * handler, so that file exists only if the child ended itself.
 */
export default defineProcessor<{
  pidFile: string;
  markerFile: string;
  exitFile: string;
  cleanupMs: number;
}>(async (job, context) => {
  process.once("exit", () => {
    writeFileSync(job.data.exitFile, "exited");
  });

  writeFileSync(
    job.data.pidFile,
    JSON.stringify({ pid: process.pid, ppid: process.ppid }),
  );

  await new Promise<void>((resolve) => {
    if (context.signal.aborted) {
      resolve();
      return;
    }
    context.signal.addEventListener("abort", () => resolve(), { once: true });
  });

  await Bun.sleep(job.data.cleanupMs);
  writeFileSync(job.data.markerFile, "cleaned up");
  return "unwound";
});
