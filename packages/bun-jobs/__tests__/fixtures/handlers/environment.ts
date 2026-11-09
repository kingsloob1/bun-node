import process from "node:process";
// The package root on purpose, as an application's handler imports it: this
// and `job-fail.ts` keep that path covered in every mode. Other fixtures take
// `defineHandler` from `lib/runner/types`, since each run loads them afresh.
import { defineHandler, isRunnerChild } from "../../../lib/index";

/** Reports how the run was started, so the child's wiring can be asserted. */
export default defineHandler(async (ctx) => ({
  isChild: isRunnerChild(),
  marker: process.env.BUN_JOBS_CHILD ?? null,
  mode: process.env.BUN_JOBS_MODE ?? null,
  namespace: process.env.BUN_JOBS_NAMESPACE ?? null,
  runId: ctx.runId,
  driverConfig: ctx.driverConfig ?? null,
  hasDriver: ctx.driver !== undefined,
}));
