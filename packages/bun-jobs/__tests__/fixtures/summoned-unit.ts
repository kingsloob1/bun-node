import type { BunQueueWorker, DriverConfig } from "../../lib/index";
import process from "node:process";
import { noopLogger } from "@kingsleyweb/bun-common";
import { BunJobs, summonedFromArgs } from "../../lib/index";

/**
 * A shared unit (PR-B3a): one process running a summoned worker for **each**
 * queue its `--bun-jobs-summon-queue=` arguments name, as a shared-unit
 * controller's summons ask. It stands in for `runSummoned(workers[])`
 * (PR-B2, not in this base): it runs every worker itself and exits 0 once
 * every queue has had nothing outstanding for `SUMMON_TEST_IDLE_MS`, closing
 * the workers, which marks each claim's exit clean.
 *
 * Test control — never identity — arrives in the environment:
 *
 * - `SUMMON_TEST_DRIVER`: the driver config, as JSON.
 * - `SUMMON_TEST_SKIP_QUEUES`: queues, comma-separated, to run **no** worker
 *   for: an entry script that forgot a queue (partial coverage).
 * - `SUMMON_TEST_IDLE_MS`: how long every queue must be idle before exiting
 *   (default 400).
 * - `SUMMON_TEST_REPORT_MS`: each worker's `reportInterval` (default 200).
 * - `SUMMON_TEST_JOB_MS`: how long each job takes (default 0).
 * - `SUMMON_TEST_KILL_AFTER_FIRST`: once its first job has run this long
 *   (ms), the process SIGKILLs itself, holding whatever it holds: a death in
 *   the unit, with no exit mark on any claim.
 *
 * Prints one JSON line per fact: `ready` (with the queues it runs), `record`
 * (each worker's record's `summon`, once listed), `processed`, `exit`.
 */

const say = (line: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(line)}\n`);
};

const summon = summonedFromArgs();
if (summon?.namespace === undefined || summon.queues === undefined) {
  throw new Error("run me with --bun-jobs-summon-namespace= and -queue=");
}
const skip = new Set(
  (process.env.SUMMON_TEST_SKIP_QUEUES ?? "")
    .split(",")
    .filter((one) => one.length > 0),
);
const queues = summon.queues.filter((queue) => !skip.has(queue));
const idleMs = Number(process.env.SUMMON_TEST_IDLE_MS ?? 400);
const jobMs = Number(process.env.SUMMON_TEST_JOB_MS ?? 0);
const killAfter = process.env.SUMMON_TEST_KILL_AFTER_FIRST;

const jobs = new BunJobs({
  namespace: summon.namespace,
  driver: JSON.parse(process.env.SUMMON_TEST_DRIVER!) as DriverConfig,
  logger: noopLogger,
});
let first = true;
const workers: BunQueueWorker[] = queues.map((queue) =>
  jobs.worker(
    queue,
    async (job) => {
      say({ event: "processed", queue, id: job.id, pid: process.pid });
      if (first && killAfter !== undefined) {
        first = false;
        setTimeout(
          () => process.kill(process.pid, "SIGKILL"),
          Number(killAfter),
        );
        await new Promise(() => {});
      }
      if (jobMs > 0) {
        await Bun.sleep(jobMs);
      }
    },
    {
      summon,
      concurrency: 2,
      pollInterval: 20,
      reportInterval: Number(process.env.SUMMON_TEST_REPORT_MS ?? 200),
    },
  ),
);
for (const worker of workers) {
  void worker.run();
}
say({ event: "ready", pid: process.pid, queues });

// Each worker's own record, once listed: what the controller releases the
// attempt by, per queue, and what claim-once decided on that queue.
await Promise.all(
  workers.map(async (worker, index) => {
    for (;;) {
      const mine = (await jobs.listWorkers()).find(
        (one) => one.id === worker.id,
      );
      if (mine) {
        say({
          event: "record",
          queue: queues[index],
          worker: worker.id,
          summon: mine.summon ?? null,
        });
        return;
      }
      await Bun.sleep(20);
    }
  }),
);

let idleSince = Date.now();
for (;;) {
  const demands = await Promise.all(
    queues.map(async (queue) => await jobs.queue(queue).getDemand()),
  );
  if (demands.some((demand) => demand.outstanding > 0)) {
    idleSince = Date.now();
  } else if (Date.now() - idleSince >= idleMs) {
    break;
  }
  await Bun.sleep(50);
}

await jobs.close();
say({ event: "exit", pid: process.pid });
process.exit(0);
