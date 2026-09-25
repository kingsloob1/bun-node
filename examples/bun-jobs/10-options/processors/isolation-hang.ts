/**
 * A processor that ignores its signal completely: it reports its process id,
 * then blocks its thread for good. Blocked, it cannot even read the worker's
 * polite `close` — only a signal stops it.
 *
 * With `ignoreSigterm` it also installs a `SIGTERM` listener, which a blocked
 * thread never gets to run, so `SIGTERM` does nothing and only the `SIGKILL`
 * that follows `killTimeout` ends it. Run by `worker-isolation.ts` under
 * `target: "child-process"`; not meant to be run on its own.
 */
import process from "node:process";
import { defineProcessor } from "@kingsleyweb/bun-jobs";

/** What a hanging job carries. */
export interface HangData {
  /** Survive `SIGTERM`, so only `SIGKILL` works. */
  ignoreSigterm?: boolean;
}

export default defineProcessor<HangData>(async (job) => {
  if (job.data.ignoreSigterm) {
    process.on("SIGTERM", () => {});
  }

  await job.updateProgress({ pid: process.pid });
  // Let the progress message leave before the thread stops turning.
  await Bun.sleep(200);

  for (;;) {
    Bun.sleepSync(50);
  }
});
