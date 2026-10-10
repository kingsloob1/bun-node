import type { DriverConfig } from "../../../lib/index";
import process from "node:process";
import { noopLogger } from "@kingsleyweb/bun-common";
import { createDriver, SummonController } from "../../../lib/index";

/**
 * One of several processes racing to summon for one summon group
 * (`summon-group-race.test.ts`). Each round has its own namespace
 * (`SUMMON_TEST_NAMESPACES`, comma-separated); in each, this process runs one
 * controller per queue in `SUMMON_TEST_QUEUES`, all in group `media` with
 * `SUMMON_TEST_PER_HOUR` attempts an hour. Every process starts round `r` at
 * `SUMMON_TEST_START_AT + r × SUMMON_TEST_SLOT_MS`, so the controllers of all
 * of them check in the same instant, and runs `SUMMON_TEST_CHECKS` checks per
 * controller, its controllers in parallel.
 *
 * Prints one JSON line per summoner call, one per check, and one per
 * `onSummonFailed` (`{ round, queue, alert }`). Several processes may name
 * the same queues: then each runs a replica controller on each.
 */

const driver = createDriver(
  JSON.parse(process.env.SUMMON_TEST_DRIVER!) as DriverConfig,
);
await driver.connect();
const namespaces = process.env.SUMMON_TEST_NAMESPACES!.split(",");
const queues = process.env.SUMMON_TEST_QUEUES!.split(",");
const startAt = Number(process.env.SUMMON_TEST_START_AT);
const slot = Number(process.env.SUMMON_TEST_SLOT_MS);
const checks = Number(process.env.SUMMON_TEST_CHECKS ?? 4);
const perHour = Number(process.env.SUMMON_TEST_PER_HOUR);

for (const [round, namespace] of namespaces.entries()) {
  const controllers = queues.map(
    (queue) =>
      new SummonController({
        driver,
        namespace,
        queue,
        summoner: async (request) => {
          process.stdout.write(
            `${JSON.stringify({ round, call: request.id, queue: request.queue })}\n`,
          );
        },
        group: { name: "media", budget: { perHour, perDay: perHour * 10 } },
        onSummonFailed: (failure) => {
          process.stdout.write(
            `${JSON.stringify({ round, queue, alert: failure.outcome })}\n`,
          );
        },
        triggers: { onAdd: false, events: false, poll: false },
        cooldown: 0,
        logger: noopLogger,
      }),
  );
  await Bun.sleep(Math.max(0, startAt + round * slot - Date.now()));
  await Promise.all(
    controllers.map(async (controller) => {
      for (let index = 0; index < checks; index++) {
        const result = await controller.check();
        process.stdout.write(
          `${JSON.stringify({
            round,
            queue: controller.queue,
            action: result.action,
            reason: "reason" in result ? result.reason : null,
          })}\n`,
        );
      }
    }),
  );
  await Promise.all(controllers.map(async (one) => await one.close()));
}
await driver.close();
process.exit(0);
