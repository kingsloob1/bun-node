import type { DriverConfig } from "../../../lib/index";
import { noopLogger } from "@kingsleyweb/bun-common";
import {
  createDriver,
  defineProcessor,
  SummonController,
} from "../../../lib/index";

/**
 * A processor that builds a `SummonController` where it runs — inside a
 * bun-jobs child-process target, marked `BUN_JOBS_CHILD=1` — and reports
 * whether it is inert there (Q42).
 */
export default defineProcessor<
  { driver: DriverConfig; namespace: string },
  { inert: boolean; action: string }
>(async (job) => {
  const driver = createDriver(job.data.driver);
  const controller = new SummonController({
    driver,
    namespace: job.data.namespace,
    queue: "elsewhere",
    summoner: async () => {},
    triggers: { poll: false, events: false },
    logger: noopLogger,
  });
  const result = await controller.check();
  await controller.close();
  await driver.close();
  return { inert: controller.inert, action: result.action };
});
