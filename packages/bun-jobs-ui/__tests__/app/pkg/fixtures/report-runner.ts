import { defineHandler } from "@kingsleyweb/bun-jobs";

/**
 * The runner handler of `runners.integration.test.ts`: returns a small
 * result, so the run the UI shows has something to display.
 */
export default defineHandler<{ rows?: number }, { rows: number }>((ctx) => ({
  rows: ctx.args?.rows ?? 12,
}));
