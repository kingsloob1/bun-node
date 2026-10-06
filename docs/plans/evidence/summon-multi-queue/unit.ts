/**
 * The child of unit-boot.ts: a stand-in for a summoned unit. Builds one
 * `BunJobs` and one worker per queue named on the command line, runs them,
 * and prints one JSON line once every worker is ready: how long that took
 * from process start, and the process's RSS. Exits on SIGTERM after closing.
 *
 *   MQ_DRIVER='<driver config JSON>' bun unit.ts <namespace> <queue> [<queue>…]
 */
import type { DriverConfig } from "../../../../packages/bun-jobs/lib/index";
import process from "node:process";
import { BunJobs } from "../../../../packages/bun-jobs/lib/index";

const [namespace, ...queues] = process.argv.slice(2);
const jobs = new BunJobs({
  namespace: namespace!,
  driver: JSON.parse(process.env.MQ_DRIVER!) as DriverConfig,
});
const workers = queues.map((queue) =>
  jobs.worker(queue, async () => "ok", { reportInterval: 1_000 }),
);
await Promise.all(
  workers.map(
    async (worker) =>
      await new Promise<void>((resolve) => {
        worker.once("ready", () => resolve());
        void worker.run();
      }),
  ),
);
console.log(
  JSON.stringify({
    readyMs: Math.round(performance.now()),
    rssMb: Math.round(process.memoryUsage().rss / 1_048_576),
  }),
);
process.once("SIGTERM", () => {
  void (async () => {
    await Promise.all(workers.map(async (worker) => await worker.close()));
    await jobs.close();
    process.exit(0);
  })();
});
