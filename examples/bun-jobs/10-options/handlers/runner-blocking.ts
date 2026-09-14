/**
 * An uncooperative handler, for `spawn` mode only: it blocks its own event
 * loop, so it never sees the `close` message, its abort signal or the
 * child's own exit timer.
 *
 * With `ignoreSigterm` it also installs a `SIGTERM` listener, which removes
 * the default "terminate" behaviour — so only `SIGKILL` ends it. Without it,
 * `SIGTERM` does. That is the difference the `closeTimeout`/`killTimeout`
 * escalation exists for.
 */
import process from "node:process";
import { defineHandler } from "@kingsleyweb/bun-jobs";

/** Arguments the blocking handler accepts. */
export interface BlockingArgs {
  /** Install a no-op `SIGTERM` listener before blocking. */
  ignoreSigterm: boolean;
  /** How long to block, in milliseconds. */
  ms: number;
}

export default defineHandler<BlockingArgs, string>(async (ctx) => {
  if (ctx.args.ignoreSigterm) {
    process.on("SIGTERM", () => {
      // Deliberately ignored.
    });
  }

  // Tell the parent the listener is in place, and give IPC a turn to flush
  // the message before the loop is blocked.
  ctx.send("blocking");
  await Bun.sleep(100);

  const until = Date.now() + ctx.args.ms;
  while (Date.now() < until) {
    // Busy-wait: nothing else in this process gets a turn.
  }

  return "survived";
});
