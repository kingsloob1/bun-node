import { writeFileSync } from "node:fs";
import process from "node:process";
import { defineProcessor } from "../../../lib/index";

/**
 * The queue-processor twin of `spin-stamp.ts`: spins, ignoring its signal and
 * `SIGTERM`, and overwrites `beaconFile` on every turn with a stamp —
 * `performance.timeOrigin + performance.now()`, in milliseconds — so a test
 * can place the thread's last side effect against the moment a close
 * resolved. Only a kill ends it before `spinMs`.
 *
 * Not `process.hrtime.bigint()`: in Bun a `Worker`'s hrtime counts from that
 * worker's own start, so a thread's stamp and the parent's would not compare
 * (oven-sh/bun#44221).
 */
export default defineProcessor<{
  /** Where the stamp is written, as milliseconds (`timeOrigin + now()`). */
  beaconFile: string;
  /** How long the run spins before it returns, in milliseconds. */
  spinMs: number;
}>((job) => {
  process.on("SIGTERM", () => {
    // Deliberately ignored.
  });

  const until = Date.now() + job.data.spinMs;
  while (Date.now() < until) {
    // Busy-wait: the abort signal and the `close` message never get a turn.
    writeFileSync(
      job.data.beaconFile,
      String(performance.timeOrigin + performance.now()),
    );
  }

  return "survived";
});
