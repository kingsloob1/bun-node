/**
 * Another process in a summon group: `02-queues/summon-group-budget.ts`
 * starts it as `bun 02-queues/helpers/summon-group-member.ts`. Not meant to
 * be run alone.
 *
 * It opens the tour's backend (`GROUP_DRIVER`, a driver config as JSON) in
 * the tour's namespace (`GROUP_NAMESPACE`), gives queue `GROUP_QUEUE` one
 * waiting job and a one-shot summon controller in group `GROUP_NAME` with
 * `GROUP_PER_HOUR` attempts an hour, runs **one** check, and prints one line
 * of JSON — what the check did and the group as this process reads it — then
 * exits. Its summoner starts nothing: every call answers `unavailable`, so an
 * attempt is charged to the group and settled at once.
 */
import type { DriverConfig, SummonCheckResult } from "@kingsleyweb/bun-jobs";
import process from "node:process";
import { noopLogger } from "@kingsleyweb/bun-common";
import { BunJobs, defineSummoner } from "@kingsleyweb/bun-jobs";

const queue = process.env.GROUP_QUEUE!;
const name = process.env.GROUP_NAME!;
const perHour = Number(process.env.GROUP_PER_HOUR);

const jobs = new BunJobs({
  namespace: process.env.GROUP_NAMESPACE!,
  driver: JSON.parse(process.env.GROUP_DRIVER!) as DriverConfig,
  logger: noopLogger,
  summon: {
    [queue]: {
      summoner: defineSummoner({
        kind: "example-busy",
        invoke: async () => ({ status: "unavailable", reason: "busy" }),
      }),
      triggers: { onAdd: false, events: false, poll: false },
      cooldown: 0,
      backoff: { initial: 1, max: 1 },
      // A circuit that never opens here: this process is about the budget.
      circuit: { failures: 1_000 },
      group: { name, budget: { perHour } },
    },
  },
});

await jobs.queue(queue).add("work", { from: "another process" });
const controller = jobs.summonController(queue);
const result: SummonCheckResult = await controller.check();
const status = await controller.status();
process.stdout.write(
  `${JSON.stringify({
    said:
      result.action === "summoned"
        ? result.outcome
        : result.action === "skipped"
          ? `skipped ${result.reason}`
          : result.action,
    group: status.group,
    pid: process.pid,
  })}\n`,
);
await jobs.close();
process.exit(0);
