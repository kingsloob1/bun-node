import { defineHandler } from "@kingsleyweb/bun-jobs";

/**
 * The handler of `run-logs.integration.test.ts`' quiet run: it logs nothing
 * at all, so its log is kept and empty — a 200 with no lines, which is not
 * the same as a log that is not retained.
 */
export default defineHandler<undefined, { ok: true }>(() => ({ ok: true }));
