import type { DriverConfig } from "../../../lib/index";
import process from "node:process";
import { noopLogger } from "@kingsleyweb/bun-common";
import {
  createDriver,
  defineSummoner,
  SummonController,
} from "../../../lib/index";

/**
 * A summon controller in its own process, for `summon-events.test.ts`: it
 * runs one manual check against the backlog the test added, with a summoner
 * that starts nothing and answers `started` with one handle, then closes —
 * which waits for its `summon` events to be published — and exits. Prints
 * the check's result, and every `summon` event it emitted locally, as JSON
 * lines.
 *
 * - `SUMMON_TEST_DRIVER`: the driver config, as JSON.
 * - `SUMMON_TEST_NAMESPACE`: the namespace; the queue is `work`.
 */

const say = (line: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(line)}\n`);
};

const driver = createDriver(
  JSON.parse(process.env.SUMMON_TEST_DRIVER!) as DriverConfig,
);
await driver.connect();
const controller = new SummonController({
  driver,
  namespace: process.env.SUMMON_TEST_NAMESPACE!,
  queue: "work",
  summoner: defineSummoner({
    kind: "fake",
    invoke: async () => ({ status: "started", handles: ["unit-1"] }),
  }),
  triggers: { onAdd: false, events: false, poll: false },
  cooldown: 0,
  logger: noopLogger,
});
controller.on("summon", (event) => say({ event: "local", payload: event }));

const result = await controller.check({ reason: "manual" });
say({ event: "checked", result });
await controller.close();
await driver.close();
process.exit(0);
