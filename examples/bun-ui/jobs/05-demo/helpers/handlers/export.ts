/**
 * A runner handler that writes a log as it works, so a run's history row has
 * a log to open: `ctx.log()` lines (the `log` stream, one a warning) and a
 * `console.info` and a `console.warn`, which capture attributes to the run
 * that made them (`stdout` and `stderr`) though it runs in-process. The
 * `console.info` line carries a made-up `apiKey=…`, which capture stores
 * redacted. It flushes the log before it returns, so a read right after the
 * run finishes sees every line.
 */
import { defineHandler } from "@kingsleyweb/bun-jobs";

/** Arguments of an export run. */
export interface ExportArgs {
  /** How many rows it reports exporting. Defaults to 3. */
  rows?: number;
}

export default defineHandler<ExportArgs, { exported: number }>(async (ctx) => {
  const rows = ctx.args?.rows ?? 3;
  ctx.log("export started", { level: "info", fields: { rows } });
  console.info(`connecting to warehouse with apiKey=pk_demo_${ctx.runnerId}`);
  for (let row = 1; row <= rows; row++) {
    ctx.log(`exported row ${row}`, { fields: { row, of: rows } });
  }
  console.warn("warehouse answered slowly; carried on");
  ctx.log("export finished", { level: "warn", fields: { rows } });
  await ctx.flushLogs();
  return { exported: rows };
});
