import { appendFileSync } from "node:fs";
import { defineHandler } from "../../../lib/index";

/**
 * Appends one line per run to a shared file, so a test in another process can
 * count how many runs actually happened, and holds the run open for `ms` so
 * a second process arrives while the lock is genuinely held.
 */
export default defineHandler<
  { marker?: string; log?: string; ms?: number },
  string
>(async (ctx) => {
  const line = `${ctx.args?.marker ?? "?"}:${ctx.runId}\n`;

  if (ctx.args?.log) {
    appendFileSync(ctx.args.log, line);
  }

  await Bun.sleep(ctx.args?.ms ?? 100);
  return line.trim();
});
