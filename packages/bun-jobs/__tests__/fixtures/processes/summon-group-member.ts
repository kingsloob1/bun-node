import type { DriverConfig } from "../../../lib/index";
import process from "node:process";
import { noopLogger } from "@kingsleyweb/bun-common";
import {
  createDriver,
  defineSummoner,
  SummonController,
} from "../../../lib/index";

/**
 * One process's controller of a queue in a summon group
 * (`summon-group-settled.test.ts`): opens `SUMMON_TEST_DRIVER` (a driver
 * config as JSON), runs a controller of `SUMMON_TEST_QUEUE` in namespace
 * `SUMMON_TEST_NAMESPACE`, in group `media` with `SUMMON_TEST_PER_HOUR`
 * attempts an hour, runs **one** check, and exits. Its summoner starts
 * nothing: every call answers `unavailable`, so an attempt is charged to the
 * group and settled at once.
 *
 * Prints one JSON line per `onSummonFailed` (`{ alert }`) and then one for
 * the check (`{ action, reason, outcome, ms }`).
 */

const driver = createDriver(
  JSON.parse(process.env.SUMMON_TEST_DRIVER!) as DriverConfig,
);
await driver.connect();
const perHour = Number(process.env.SUMMON_TEST_PER_HOUR);
const controller = new SummonController({
  driver,
  namespace: process.env.SUMMON_TEST_NAMESPACE!,
  queue: process.env.SUMMON_TEST_QUEUE!,
  summoner: defineSummoner({
    kind: "member-busy",
    invoke: async () => ({ status: "unavailable", reason: "busy" }),
  }),
  group: { name: "media", budget: { perHour, perDay: perHour * 10 } },
  onSummonFailed: (failure) => {
    process.stdout.write(`${JSON.stringify({ alert: failure.outcome })}\n`);
  },
  triggers: { onAdd: false, events: false, poll: false },
  cooldown: 0,
  backoff: { initial: 1, max: 1 },
  circuit: { failures: 1_000 },
  logger: noopLogger,
});
const started = performance.now();
const result = await controller.check();
const ms = Math.round(performance.now() - started);
// `onSummonFailed` is delivered a turn later: give it that turn.
await new Promise((resolve) => setImmediate(resolve));
process.stdout.write(
  `${JSON.stringify({
    action: result.action,
    reason: "reason" in result ? result.reason : null,
    outcome: "outcome" in result ? result.outcome : null,
    ms,
  })}\n`,
);
await controller.close();
await driver.close();
process.exit(0);
