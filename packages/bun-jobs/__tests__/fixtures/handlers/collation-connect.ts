import { defineHandler, jobsFromContext } from "../../../lib/index";

/**
 * Builds the run's own driver from `ctx.driverConfig` and connects it, as any
 * handler reaching the runner's backend does — which is what runs the SQL
 * driver's collation check in a spawned or worker run.
 */
export default defineHandler(async (ctx) => {
  const jobs = jobsFromContext(ctx);
  try {
    await jobs.driver.connect();
    return { connected: true };
  } finally {
    await jobs.close();
  }
});
