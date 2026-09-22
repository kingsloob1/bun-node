import { defineHandler } from "../../../lib/index";

/**
 * Ends the way its arguments say: `"ok"` returns at once, `"throw"` fails,
 * `"sleep"` sleeps `ms` honouring its signal — so one runner can produce every
 * outcome the analytics series counts.
 */
export default defineHandler<
  { do?: "ok" | "throw" | "sleep"; ms?: number },
  string
>(async (ctx) => {
  const action = ctx.args?.do ?? "ok";

  if (action === "throw") {
    throw new Error("asked to fail");
  }

  if (action === "sleep") {
    const started = Date.now();
    while (Date.now() - started < (ctx.args?.ms ?? 50)) {
      if (ctx.signal.aborted) {
        return "aborted";
      }
      await Bun.sleep(5);
    }
  }

  return action;
});
