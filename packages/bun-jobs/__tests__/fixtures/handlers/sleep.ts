import { defineHandler } from "../../../lib/index";

/** Sleeps for `ms`, honouring the abort signal so it can be stopped. */
export default defineHandler<{ ms?: number }, string>(async (ctx) => {
  const ms = ctx.args?.ms ?? 50;
  const started = Date.now();

  while (Date.now() - started < ms) {
    if (ctx.signal.aborted) {
      return "aborted";
    }
    await Bun.sleep(5);
  }

  return "slept";
});
