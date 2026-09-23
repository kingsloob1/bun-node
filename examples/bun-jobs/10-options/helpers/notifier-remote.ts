/**
 * Another process, for `notifier.ts`: it adds a job and runs it, publishing
 * every event, then exits. Everything arrives through the environment.
 *
 * - `ROLE=produce-and-consume` adds one job to `remote` and completes it.
 * - `ROLE=hang` claims a job from `remote` and never finishes it, so the
 *   parent can kill this process and watch the job be recovered as stalled.
 *
 * Not meant to be run on its own.
 */
import type { DriverConfig } from "@kingsleyweb/bun-jobs";
import process from "node:process";
import { BunJobs } from "@kingsleyweb/bun-jobs";

const jobs = new BunJobs({
  namespace: process.env.NAMESPACE ?? "",
  driver: JSON.parse(process.env.DRIVER_CONFIG ?? "{}") as DriverConfig,
  publishEvents: true,
});

/**
 * The sweep cadence the parent runs its rescuer at. It reaches this process
 * too, so that every worker on the queue sweeps at the same short interval and
 * the recovery cannot hinge on which of them does it. See the parent.
 */
const stalledInterval = Number(process.env.STALLED_INTERVAL ?? 200);

if (process.env.ROLE === "hang") {
  const worker = jobs.worker(
    "remote",
    // Takes the job and hangs, until the parent kills this process.
    () => new Promise<never>(() => {}),
    { lockDuration: 500, pollInterval: 20, stalledInterval },
  );
  // `void`, not a top-level await that never settles.
  void worker.run();
} else {
  const worker = jobs.worker<{ greeting: string }, { from: number }>(
    "remote",
    async () => ({ from: process.pid }),
    { pollInterval: 20, stalledInterval },
  );

  worker.on("completed", () => {
    void jobs.close().then(() => process.exit(0));
  });

  void worker.run();
  await jobs.queue("remote").add("hello", { greeting: "from a child" });
}
