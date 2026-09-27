import { writeFileSync } from "node:fs";
import process from "node:process";
import { defineProcessor } from "../../../lib/index";

/**
 * Says who it is, then naps for `napMs` and returns `"napped"`: a job that
 * finishes on its own, well inside a graceful close's `timeout`.
 *
 * Like `job-spin-report`, it writes its own pid and its parent's to `pidFile`
 * first, synchronously, so a test knows exactly which process ran it.
 */
export default defineProcessor<{ pidFile: string; napMs: number }>(
  async (job) => {
    writeFileSync(
      job.data.pidFile,
      JSON.stringify({ pid: process.pid, ppid: process.ppid }),
    );
    await Bun.sleep(job.data.napMs);
    return "napped";
  },
);
