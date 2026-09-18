import { defineHandler } from "@kingsleyweb/bun-jobs";

/** The runner behind `runner-actions.integration.test.ts`: finishes at once. */
export default defineHandler<unknown, { ok: true; source: string }>((ctx) => ({
  ok: true,
  source: ctx.source,
}));
