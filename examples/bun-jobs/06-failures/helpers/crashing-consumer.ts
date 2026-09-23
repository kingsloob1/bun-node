/**
 * A consumer process that takes a job and never finishes it — so that
 * `timeouts-and-cancellation.ts` can kill it with `SIGKILL` mid-job, the way a
 * container is OOM-killed or a host loses power.
 *
 * Not meant to be run on its own: everything arrives through the environment.
 */
import type { DriverConfig } from "@kingsleyweb/bun-jobs";
import process from "node:process";
import { BunQueueWorker } from "@kingsleyweb/bun-jobs";

const worker = new BunQueueWorker(
  "exports",
  // Takes the job and hangs.
  () => new Promise<never>(() => {}),
  {
    namespace: process.env.NAMESPACE ?? "",
    driver: JSON.parse(process.env.DRIVER_CONFIG ?? "{}") as DriverConfig,
    id: "doomed-worker",
    // Short, so the lock lapses soon after the kill.
    lockDuration: Number(process.env.LOCK_DURATION ?? 500),
    // Short for the same reason, and it comes from the parent so that both
    // workers on the queue sweep at one cadence — the recovery must not depend
    // on which of them sweeps. See the parent for why that matters.
    stalledInterval: Number(process.env.STALLED_INTERVAL ?? 100),
    pollInterval: 20,
  },
);

// The running worker keeps the process alive until it is killed.
void worker.run();
