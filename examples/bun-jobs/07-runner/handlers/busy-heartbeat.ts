/**
 * A handler that never yields: it spins, ignoring its signal, and writes a
 * heartbeat to a file on every turn, so the runner's parent can tell whether
 * the thread is still running by reading the file twice.
 *
 * The heartbeat is a stamp in milliseconds on one clock the whole process
 * shares, `performance.timeOrigin + performance.now()`. Not
 * `process.hrtime`: in Bun a `Worker`'s hrtime counts from that worker's own
 * start, so a thread's stamp and the parent's would not compare
 * (oven-sh/bun#44221).
 *
 * Only a timeout, `kill()` or `stop()` ends it before `spinMs`: the loop
 * never awaits, so its signal and the runner's `close` message never get a
 * turn, and the runner has to terminate the thread.
 *
 * With `linger` it stands in for a thread that is slow to go after its run
 * has reported. It returns once `releaseFile` exists, and every message the
 * thread posts to the parent after that, its result first among them, is
 * followed by a `Bun.sleepSync`: a native wait `terminate()` cannot cut
 * short. The result is already on its way, so the runner has it, and the
 * thread goes on for `linger.ms` after it. Just before blocking it writes
 * `linger.markerFile`, so the parent can tell the thread is inside the wait.
 *
 * The runner terminates the thread the moment the result arrives, and that
 * can land before the thread reaches the wait, sooner even than a
 * `setTimeout(..., 0)` in the thread fires. So the parent holds its own event
 * loop still, synchronously, from writing `releaseFile` until the marker
 * appears: it cannot read the result, or terminate anything, until the thread
 * is already blocked.
 */
import { existsSync, writeFileSync } from "node:fs";
import { defineHandler } from "@kingsleyweb/bun-jobs";

/** Arguments the busy handler accepts. */
export interface BusyHeartbeatArgs {
  /** The file the heartbeat is written to, overwritten on every turn. */
  beaconFile: string;
  /** How long to spin before returning, in milliseconds. */
  spinMs: number;
  /** Return as soon as this file exists, rather than after `spinMs`. */
  releaseFile?: string;
  /** After returning, keep the thread blocked. Unset, it has nothing left to do. */
  linger?: {
    /** How long each block lasts, in milliseconds. */
    ms: number;
    /** Written just before the thread blocks. */
    markerFile: string;
  };
}

export default defineHandler<BusyHeartbeatArgs, string>((ctx) => {
  const { beaconFile, spinMs, releaseFile, linger } = ctx.args;

  const until = Date.now() + spinMs;
  while (Date.now() < until) {
    writeFileSync(
      beaconFile,
      String(performance.timeOrigin + performance.now()),
    );
    if (releaseFile !== undefined && existsSync(releaseFile)) {
      break;
    }
  }

  if (linger !== undefined) {
    // In a worker the global scope is the thread's own, and its
    // `postMessage` is how the result reaches the parent.
    const scope = globalThis as unknown as {
      postMessage: (message: unknown) => void;
    };
    const post = scope.postMessage.bind(scope);
    scope.postMessage = (message) => {
      post(message);
      writeFileSync(linger.markerFile, "blocked");
      Bun.sleepSync(linger.ms);
    };
  }

  return "returned";
});
