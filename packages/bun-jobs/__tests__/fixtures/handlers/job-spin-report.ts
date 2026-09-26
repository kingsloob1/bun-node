import { writeFileSync } from "node:fs";
import process from "node:process";
import { defineProcessor } from "../../../lib/index";

/**
 * Says who it is, then spins and ignores its signal: the processor a
 * child-process target can only stop with `SIGKILL`.
 *
 * It writes its own pid and its parent's to `pidFile` **synchronously**, before
 * the spin. Nothing asynchronous would get a turn after that — an IPC message
 * or a progress update would sit unsent behind a loop that never yields — so a
 * file is the one report that is certain to be out before the child becomes
 * deaf. The test identifies the child by this, not by searching command lines:
 * the child's command line names `spawn-entry.ts`, never this file.
 */
export default defineProcessor<{ pidFile: string; spinMs: number }>((job) => {
  process.on("SIGTERM", () => {
    // Deliberately ignored.
  });

  writeFileSync(
    job.data.pidFile,
    JSON.stringify({ pid: process.pid, ppid: process.ppid }),
  );

  const until = Date.now() + job.data.spinMs;
  while (Date.now() < until) {
    // Busy-wait: the abort signal and the IPC `close` never get a turn.
  }

  return "survived";
});
