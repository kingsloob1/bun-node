/**
 * A process whose only work is a worker on an empty queue — a worker service,
 * reduced to its shape — so `worker-options.ts` can see whether `waitToExit`
 * keeps it alive. It never calls `process.exit`: whether it goes away by
 * itself is the thing under test.
 *
 * Not meant to be run on its own: everything arrives through the environment.
 */
import type { DriverConfig } from "@kingsleyweb/bun-jobs";
import process from "node:process";
import { BunQueueWorker } from "@kingsleyweb/bun-jobs";

const worker = new BunQueueWorker("idle", async () => null, {
  namespace: process.env.NAMESPACE ?? "",
  driver: JSON.parse(process.env.DRIVER_CONFIG ?? "{}") as DriverConfig,
  pollInterval: 25,
  maxBlock: 50,
  waitToExit: process.env.WAIT_TO_EXIT !== "false",
});

worker.on("ready", () => {
  console.log("ready");
});

// With CLOSE_AFTER_MS, the script's "own work" ends that long after the worker
// is ready: closing the worker closes the driver it built from the config,
// which is what releases a networked driver's connection.
const closeAfterMs = Number(process.env.CLOSE_AFTER_MS ?? 0);
if (closeAfterMs > 0) {
  worker.once("ready", () => {
    setTimeout(() => {
      void worker.close();
    }, closeAfterMs);
  });
}

// Not a top-level await: Bun spins on one that never settles, which would
// keep this process alive whatever the worker did.
void worker.run();
