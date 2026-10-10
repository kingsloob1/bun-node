import type { DriverConfig } from "../../../lib/index";
import process from "node:process";
import { noopLogger } from "@kingsleyweb/bun-common";
import { createDriver, SummonController } from "../../../lib/index";

/**
 * One of several processes racing to summon one shared unit
 * (`summon-shared-unit-xproc.test.ts`, plan §7 (B) 1). Each round has its
 * own namespace (`SUMMON_TEST_NAMESPACES`, comma-separated); in each, this
 * process runs one shared-unit controller over `SUMMON_TEST_QUEUES` in group
 * `media` — or, with `SUMMON_TEST_PER_QUEUE=1`, the expansion form's one
 * controller per queue, the contrast. Every process starts round `r` at
 * `SUMMON_TEST_START_AT + r × SUMMON_TEST_SLOT_MS`, and runs
 * `SUMMON_TEST_CHECKS` checks per controller, its controllers in parallel.
 *
 * The summoner starts nothing: it prints the request's id and argv, which
 * the test may hand to a unit itself. One JSON line per call and per check.
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
const perQueue = process.env.SUMMON_TEST_PER_QUEUE === "1";

for (const [round, namespace] of namespaces.entries()) {
  const common = {
    driver,
    namespace,
    summoner: async (request: { id: string; argv: readonly string[] }) => {
      process.stdout.write(
        `${JSON.stringify({ round, call: request.id, argv: request.argv })}\n`,
      );
    },
    triggers: { onAdd: false, events: false, poll: false as const },
    cooldown: 0,
    logger: noopLogger,
  };
  const controllers = perQueue
    ? queues.map(
        (queue) =>
          new SummonController({
            ...common,
            queue,
            group: { name: "media" },
          }),
      )
    : [
        new SummonController({
          ...common,
          queues,
          group: { name: "media", unit: "shared" },
        }),
      ];
  await Bun.sleep(Math.max(0, startAt + round * slot - Date.now()));
  await Promise.all(
    controllers.map(async (controller) => {
      for (let index = 0; index < checks; index++) {
        const result = await controller.check();
        process.stdout.write(
          `${JSON.stringify({
            round,
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
