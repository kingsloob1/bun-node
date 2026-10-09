import type { DriverConfig } from "../../../lib/index";
import process from "node:process";
import { noopLogger } from "@kingsleyweb/bun-common";
import {
  BunQueue,
  createDriver,
  defineSummoner,
  ProviderError,
  SummonController,
} from "../../../lib/index";

/**
 * Writes summon state from a process of its own, for
 * `api-summon-remote.test.ts`: the API under test has no controller for
 * these queues and must read it all from storage.
 *
 * In namespace `SUMMON_TEST_NAMESPACE`, group `media` (a budget of 7 an
 * hour, a shared circuit): `renders` summons once (`started`, kind
 * `remote-kind`, its own budget 4 an hour); `thumbs` (kind `broken-kind`,
 * budget off) has its credentials rejected, which opens its queue's circuit
 * and the group's for that kind. Prints `{"done":true}` and exits.
 */

const driver = createDriver(
  JSON.parse(process.env.SUMMON_TEST_DRIVER!) as DriverConfig,
);
await driver.connect();
const namespace = process.env.SUMMON_TEST_NAMESPACE!;
const quiet = {
  triggers: { onAdd: false, events: false, poll: false as const },
  cooldown: 0,
  logger: noopLogger,
};
const group = { name: "media", budget: { perHour: 7 }, circuit: true };

for (const name of ["renders", "thumbs"]) {
  const queue = new BunQueue(name, { namespace, driver, logger: noopLogger });
  await queue.add("a", {});
  await queue.close();
}

const renders = new SummonController({
  ...quiet,
  driver,
  namespace,
  queue: "renders",
  summoner: defineSummoner({
    kind: "remote-kind",
    invoke: async () => ({ status: "started", handles: ["h-1"] }),
  }),
  budget: { perHour: 4 },
  group,
});
const thumbs = new SummonController({
  ...quiet,
  driver,
  namespace,
  queue: "thumbs",
  summoner: defineSummoner({
    kind: "broken-kind",
    invoke: async () => {
      throw new ProviderError("credentials rejected", "auth", {
        platformCode: "InvalidToken",
      });
    },
  }),
  budget: false,
  group,
});
const results = [await renders.check(), await thumbs.check()];
await renders.close();
await thumbs.close();
await driver.close();
process.stdout.write(
  `${JSON.stringify({ done: true, actions: results.map((one) => one.action) })}\n`,
);
process.exit(0);
