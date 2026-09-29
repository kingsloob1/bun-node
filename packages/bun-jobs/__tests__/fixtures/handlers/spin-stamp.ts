import { writeFileSync } from "node:fs";
import process from "node:process";
import { defineHandler } from "../../../lib/index";

/**
 * Spins, ignoring its signal, and overwrites `beaconFile` with a stamp —
 * `performance.timeOrigin + performance.now()`, in milliseconds — on every
 * turn: the handler only a kill can stop, whose last side effect a test can
 * place in time against the moment a close resolved.
 *
 * Not `process.hrtime.bigint()`: in Bun a `Worker`'s hrtime counts from that
 * worker's own start, not from one origin the whole process shares as it does
 * in Node, so a stamp from a thread cannot be compared with one from the
 * parent (oven-sh/bun#44221). `timeOrigin + now()` is one clock across
 * threads in both.
 *
 * Everything is **synchronous**, from inside the spin. With `chatter`, it also
 * reports a progress value, sends a message and logs a line every
 * millisecond, so a test can see what reaches the parent once the run has
 * been settled while the thread is still dying.
 */
export default defineHandler<
  {
    /** Where the stamp is written, as milliseconds (`timeOrigin + now()`). */
    beaconFile: string;
    /** How long to spin before returning, in milliseconds. */
    spinMs: number;
    /** Whether to report progress, send a message and log every millisecond. */
    chatter?: boolean;
    /** How often to write the stamp, in milliseconds; `0` (the default) is every turn. */
    stampMs?: number;
    /**
     * Blocks in `Bun.sleepSync` for this long before each stamp, in
     * milliseconds: a native wait `terminate()` cannot cut short, so the
     * thread's last stamp lands up to this long after the kill.
     */
    blockMs?: number;
  },
  string
>((ctx) => {
  const args = ctx.args!;
  process.on("SIGTERM", () => {
    // Deliberately ignored.
  });

  const until = Date.now() + args.spinMs;
  const every = args.stampMs ?? 0;
  let stampAt = 0;
  let next = 0;
  let beat = 0;
  while (Date.now() < until) {
    if (args.blockMs) {
      Bun.sleepSync(args.blockMs);
    }
    if (every === 0 || Date.now() >= stampAt) {
      writeFileSync(
        args.beaconFile,
        String(performance.timeOrigin + performance.now()),
      );
      stampAt = Date.now() + every;
    }
    if (args.chatter && Date.now() >= next) {
      beat += 1;
      ctx.progress(beat);
      ctx.send({ beat });
      ctx.logger.info(`beat ${beat}`);
      next = Date.now() + 1;
    }
  }

  return "survived";
});
