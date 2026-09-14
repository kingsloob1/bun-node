/**
 * The runner handler `notifier.ts` triggers, so its runs end in each of the
 * ways a runner publishes: success, failure, a timeout, or a kill.
 *
 * Not meant to be run on its own.
 */
import { defineHandler } from "@kingsleyweb/bun-jobs";

/** How a run of this handler should end. */
export interface NotifierHandlerArgs {
  /**
   * `"ok"` returns at once, `"fail"` throws, `"hang"` waits until the run is
   * aborted (by a timeout or a kill) and then throws.
   */
  action: "ok" | "fail" | "hang";
}

export default defineHandler<NotifierHandlerArgs, string>(async (ctx) => {
  if (ctx.args.action === "fail") {
    throw new Error("the report could not be built");
  }

  if (ctx.args.action === "hang") {
    await new Promise<never>((_resolve, reject) => {
      ctx.signal.addEventListener(
        "abort",
        () => {
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });
  }

  return "ok";
});
