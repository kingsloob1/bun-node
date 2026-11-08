import { defineHandler } from "@kingsleyweb/bun-jobs";

/**
 * A runner handler for `analytics.integration.test.ts` that throws when asked
 * to: a run that threw is the one outcome a runner series counts as `failed`.
 */
export default defineHandler<{ fail?: boolean }, { ok: true }>((ctx) => {
  if (ctx.args?.fail) {
    throw new Error("asked to fail");
  }
  return { ok: true };
});
