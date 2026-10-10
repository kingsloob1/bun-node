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
 *   the unit, with no exit mark on any claim. With
 *   `SUMMON_TEST_CLOSE_QUEUE`, the wait starts once that close is done.
 * - `SUMMON_TEST_CLOSE_QUEUE`: once every worker's record is listed, closes
 *   this queue's worker cleanly (an exit mark with code `0` on its claim),
 *   the others running on: a unit that ended well on one queue only.
 *
 * Prints one JSON line per fact: `ready` (with the queues it runs), `record`
 * (each worker's record's `summon`, once listed), `processed`, `closed`,
 * `exit`.
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
const closeQueue = process.env.SUMMON_TEST_CLOSE_QUEUE;
// Resolved once `closeQueue`'s worker has closed (at once without one): the
// kill waits for it, so the death always comes after the clean close.
let closeDone!: () => void;
const closed = new Promise<void>((resolve) => {
  closeDone = resolve;
});
if (closeQueue === undefined) {
  closeDone();
}

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
        void closed.then(() =>
          setTimeout(
            () => process.kill(process.pid, "SIGKILL"),
            Number(killAfter),
          ),
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

if (closeQueue !== undefined) {
  const index = queues.indexOf(closeQueue);
  if (index === -1) {
    throw new Error(
      `SUMMON_TEST_CLOSE_QUEUE names ${closeQueue}, not a queue run here`,
    );
  }
  await workers[index]!.close();
  say({ event: "closed", queue: closeQueue });
  closeDone();
}

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
