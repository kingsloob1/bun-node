/**
 * A handler whose module takes two seconds to import, as one that opens a
 * connection or loads a model at the top level might. It sends `"invoked"`
 * the moment it is called, then waits for its signal.
 *
 * A run killed right after it is triggered is therefore stopped before its
 * handler can be called: the `close` reaches the child while it is still
 * booting, or while this module is still importing. Either way the runner
 * ends the run without calling the handler, so `"invoked"` never arrives.
 * (The two seconds of top-level work still happen: skipping the call cannot
 * undo a module that has already been evaluated.)
 */
import { defineHandler } from "@kingsleyweb/bun-jobs";

await Bun.sleep(2_000);

export default defineHandler(async (ctx) => {
  ctx.send("invoked");
  await new Promise<void>((resolve) => {
    if (ctx.signal.aborted) {
      resolve();
      return;
    }
    ctx.signal.addEventListener("abort", () => resolve(), { once: true });
  });
  return "stopped";
});
