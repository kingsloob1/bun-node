import { writeFileSync } from "node:fs";
import { defineHandler } from "../../../lib/index";

/**
 * Unwinds when asked, so the escalation never has to reach for a signal.
 * `ready`, when given, is a file written once the handler is running.
 */
export default defineHandler<{ ms?: number; ready?: string }, string>(
  async (ctx) => {
    if (ctx.args?.ready) {
      writeFileSync(ctx.args.ready, "1");
    }

    const until = Date.now() + (ctx.args?.ms ?? 5000);

    while (Date.now() < until) {
      if (ctx.signal.aborted) {
        return "unwound";
      }
      await Bun.sleep(5);
    }

    return "finished";
  },
);
