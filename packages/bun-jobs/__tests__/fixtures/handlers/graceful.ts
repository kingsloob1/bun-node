import { defineHandler } from "../../../lib/index";

/** Unwinds when asked, so the escalation never has to reach for a signal. */
export default defineHandler<{ ms?: number }, string>(async (ctx) => {
  const until = Date.now() + (ctx.args?.ms ?? 5000);

  while (Date.now() < until) {
    if (ctx.signal.aborted) {
      return "unwound";
    }
    await Bun.sleep(5);
  }

  return "finished";
});
