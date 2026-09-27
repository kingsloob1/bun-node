/**
 * A process a summoner started, building a controller the way a config
 * module shared with the worker would. `02-queues/summon-controller.ts` runs
 * it with a `--bun-jobs-summon-id=` argument; not meant to be run alone.
 *
 * It prints one JSON line: whether the controller is inert here, why, and
 * what a check does — which must be nothing, or a summoned worker's config
 * could summon more workers.
 */
import type { DriverConfig } from "@kingsleyweb/bun-jobs";
import process from "node:process";
import { createDriver, SummonController } from "@kingsleyweb/bun-jobs";

const driver = createDriver(
  JSON.parse(process.env.SUMMONED_DRIVER!) as DriverConfig,
);
await driver.connect();
let called = false;
const controller = new SummonController({
  driver,
  namespace: process.env.SUMMON_NAMESPACE!,
  queue: process.env.SUMMON_QUEUE!,
  summoner: async () => {
    called = true;
  },
  triggers: { onAdd: false, events: false, poll: false },
});
const check = await controller.check();
const status = await controller.status();
console.log(
  JSON.stringify({
    inert: controller.inert,
    inertReason: status.inertReason ?? null,
    check,
    called,
  }),
);
await controller.close();
await driver.close();
