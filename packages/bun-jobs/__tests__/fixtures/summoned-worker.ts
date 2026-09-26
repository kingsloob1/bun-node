import type { DriverConfig } from "../../lib/index";
import process from "node:process";
import { noopLogger } from "@kingsleyweb/bun-common";
import { BunJobs, summonedFromArgs } from "../../lib/index";

/**
 * The worker a fake platform summons (`helpers/summon.ts`): the recipe every
 * summoned platform runs, reduced to what a test can observe.
 *
 * It reads its provenance from `--bun-jobs-summon-*=` arguments, consumes the
 * queue they name with `summon` on its worker, and exits 0 once nothing has
 * been outstanding for `SUMMON_TEST_IDLE_MS` (a stand-in for `runSummoned`,
 * which is a later PR). Test control — never identity — arrives in the
 * environment:
 *
 * - `SUMMON_TEST_DRIVER`: the driver config, as JSON.
 * - `SUMMON_TEST_NAMESPACE` / `SUMMON_TEST_QUEUE`: where to consume when no
 *   argument names it (a `passes: "none"` platform).
 * - `SUMMON_TEST_IDLE_MS`: how long idle before exiting (default 400).
 * - `SUMMON_TEST_CRASH_AFTER_MS`: take a job, then exit 1 this long after
 *   start, holding it.
 * - `SUMMON_TEST_STALLED_MS`: the worker's `stalledInterval`.
 * - `SUMMON_TEST_LOCK_MS`: the worker's `lockDuration`.
 *
 * Prints one JSON line per fact: `ready`, `record` (its own heartbeat record's
 * `summon`, once listed), `processed`, `exit`.
 */

const say = (line: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(line)}\n`);
};

const summon = summonedFromArgs();
const driver = JSON.parse(process.env.SUMMON_TEST_DRIVER!) as DriverConfig;
const namespace = summon?.namespace ?? process.env.SUMMON_TEST_NAMESPACE!;
const queueName = summon?.queue ?? process.env.SUMMON_TEST_QUEUE!;
const idleMs = Number(process.env.SUMMON_TEST_IDLE_MS ?? 400);
const crashAfter = process.env.SUMMON_TEST_CRASH_AFTER_MS;
const stalled = process.env.SUMMON_TEST_STALLED_MS;
const lock = process.env.SUMMON_TEST_LOCK_MS;

const jobs = new BunJobs({ namespace, driver, logger: noopLogger });
const worker = jobs.worker(
  queueName,
  async (job) => {
    say({ event: "processed", id: job.id, pid: process.pid });
    if (crashAfter !== undefined) {
      // Hold the job: the process dies with it active and locked.
      await new Promise(() => {});
    }
  },
  {
    summon,
    concurrency: 4,
    pollInterval: 20,
    reportInterval: 200,
    ...(stalled === undefined ? {} : { stalledInterval: Number(stalled) }),
    ...(lock === undefined ? {} : { lockDuration: Number(lock) }),
  },
);
void worker.run();
say({ event: "ready", pid: process.pid, id: worker.id });

if (crashAfter !== undefined) {
  setTimeout(() => process.exit(1), Number(crashAfter));
}

// Its own record, once it is listed: what the controller releases the
// attempt by, and what claim-once decides.
for (;;) {
  const mine = (await jobs.listWorkers()).find((one) => one.id === worker.id);
  if (mine) {
    say({
      event: "record",
      summon: mine.summon ?? null,
      held: worker.summon ?? null,
    });
    break;
  }
  await Bun.sleep(20);
}

const queue = jobs.queue(queueName);
let idleSince = Date.now();
for (;;) {
  const demand = await queue.getDemand();
  if (demand.outstanding > 0) {
    idleSince = Date.now();
  } else if (Date.now() - idleSince >= idleMs) {
    break;
  }
  await Bun.sleep(50);
}

await jobs.close();
say({ event: "exit", pid: process.pid });
process.exit(0);
