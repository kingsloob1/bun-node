/**
 * A consumer process that claims a job and never finishes it, so that
 * `worker-options.ts` can kill it with `SIGKILL` mid-job — twice — and watch
 * the stalled sweep bury the job once it has stalled more than
 * `maxStalledCount` allows.
 *
 * Not meant to be run on its own: everything arrives through the environment.
 */
import type { DriverConfig } from "@kingsleyweb/bun-jobs";
import process from "node:process";
import { BunQueueWorker } from "@kingsleyweb/bun-jobs";

const worker = new BunQueueWorker(
  process.env.QUEUE ?? "stalls",
  // Takes the job and hangs until the process is killed.
  async () => await new Promise<never>(() => {}),
  {
    namespace: process.env.NAMESPACE ?? "",
    driver: JSON.parse(process.env.DRIVER_CONFIG ?? "{}") as DriverConfig,
    id: process.env.WORKER_ID ?? "doomed",
    // Short, so the lock lapses soon after the kill.
    lockDuration: 500,
    pollInterval: 20,
    // The parent's sweeper is the one recovering jobs.
    maintenance: false,
  },
);

// Not a top-level await: Bun spins on one that never settles.
void worker.run();
