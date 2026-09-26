import type { DriverConfig } from "../../../lib/index";
import process from "node:process";
import { noopLogger } from "@kingsleyweb/bun-common";
import { createDriver, SummonController } from "../../../lib/index";

/**
 * One of two processes racing to summon for the same backlog
 * (`summon-race.test.ts`). Waits for `SUMMON_TEST_START_AT` so both check at
 * the same instant, runs `SUMMON_TEST_CHECKS` checks back to back, and prints
 * one JSON line per check and one per summoner call.
 */

const driver = createDriver(
  JSON.parse(process.env.SUMMON_TEST_DRIVER!) as DriverConfig,
);
await driver.connect();
const controller = new SummonController({
  driver,
  namespace: process.env.SUMMON_TEST_NAMESPACE!,
  queue: "work",
  summoner: async (request) => {
    process.stdout.write(`${JSON.stringify({ call: request.id })}\n`);
  },
  triggers: { onAdd: false, events: false, poll: false },
  cooldown: 0,
  logger: noopLogger,
});

await Bun.sleep(
  Math.max(0, Number(process.env.SUMMON_TEST_START_AT) - Date.now()),
);
for (
  let index = 0;
  index < Number(process.env.SUMMON_TEST_CHECKS ?? 3);
  index++
) {
  const result = await controller.check();
  process.stdout.write(
    `${JSON.stringify({ action: result.action, reason: "reason" in result ? result.reason : null })}\n`,
  );
}
await controller.close();
await driver.close();
process.exit(0);
