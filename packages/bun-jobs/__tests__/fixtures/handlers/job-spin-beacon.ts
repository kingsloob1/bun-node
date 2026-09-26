import { writeFileSync } from "node:fs";
import process from "node:process";
import { isMainThread, threadId } from "node:worker_threads";
import { defineProcessor } from "../../../lib/index";

/**
 * Says who it is, then spins, ignoring its signal and `SIGTERM`, and writes a
 * beacon as it goes: the processor only a kill can stop, in a form a test can
 * watch whether it still runs — a child by its pid, a `Worker` by its beacon,
 * which a thread shares a pid with and so can only be seen by.
 *
 * Everything is written **synchronously**, from inside the spin: nothing
 * asynchronous would ever get a turn. `pidFile` gets the pid, the parent's pid
 * and the thread before the spin starts; `beaconFile` gets an increasing
 * count every `beaconMs` until the run ends.
 */
export default defineProcessor<{
  /** Where the run writes who it is, once, before it spins. */
  pidFile: string;
  /** Where the run writes its increasing count while it spins. */
  beaconFile: string;
  /** How often the beacon is written, in milliseconds. */
  beaconMs: number;
  /** How long the run spins before it returns, in milliseconds. */
  spinMs: number;
}>((job) => {
  process.on("SIGTERM", () => {
    // Deliberately ignored.
  });

  writeFileSync(
    job.data.pidFile,
    JSON.stringify({
      pid: process.pid,
      ppid: process.ppid,
      thread: isMainThread ? 0 : threadId,
    }),
  );

  const until = Date.now() + job.data.spinMs;
  let beats = 0;
  let next = 0;
  while (Date.now() < until) {
    // Busy-wait: the abort signal and the IPC `close` never get a turn.
    if (Date.now() >= next) {
      beats += 1;
      writeFileSync(job.data.beaconFile, String(beats));
      next = Date.now() + job.data.beaconMs;
    }
  }

  return "survived";
});
