import { defineProcessor } from "../../../lib/index";

/**
 * Tries each 2.12 operation an isolated job cannot do — `schedule()`,
 * `update()`, `disable()` and `enable()` — and returns what each was told.
 */
export default defineProcessor<unknown, Record<string, string>>(async (job) => {
  const attempts: Record<string, () => Promise<unknown>> = {
    schedule: async () => await job.schedule("in 10 minutes"),
    update: async () => await job.update({ priority: 2 }),
    disable: async () => await job.disable(),
    enable: async () => await job.enable(),
  };
  const told: Record<string, string> = {};

  for (const [method, attempt] of Object.entries(attempts)) {
    try {
      await attempt();
      told[method] = "no error";
    } catch (error) {
      told[method] = (error as Error).message;
    }
  }

  return told;
});
