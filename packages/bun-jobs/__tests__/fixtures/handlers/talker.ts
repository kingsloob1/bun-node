import { defineHandler } from "../../../lib/index";

/**
 * Calls `ctx.log()` — the explicit run-log call — in every shape it takes:
 * with a level and fields, with a level alone, and with nothing but a message.
 *
 * `flush` makes it await `ctx.flushLogs()` before returning, so a test can
 * assert the call exists and never rejects in any realm.
 */
export default defineHandler<{ flush?: boolean }, { logged: number }>(
  async (ctx) => {
    ctx.log("plain");
    ctx.log("levelled", { level: "warn" });
    ctx.log("with fields", { level: "debug", fields: { count: 3, ok: true } });

    if (ctx.args?.flush) {
      await ctx.flushLogs();
    }

    return { logged: 3 };
  },
);
