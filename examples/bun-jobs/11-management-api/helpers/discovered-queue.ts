/**
 * Another process, for `live-events-delivery.ts`: it creates the `imports`
 * queue the parent's management API has never heard of, and then runs a
 * worker on it when told to. Driven over stdin, one command a line:
 *
 * - `run` starts a publishing worker on `imports` (its first `run()`);
 * - `exit`, or stdin closing, closes everything and exits.
 *
 * It prints `created` once the queue exists and `running` once the worker has
 * started. The namespace and driver config arrive through the environment.
 *
 * Not meant to be run on its own.
 */
import type { BunQueueWorker, DriverConfig } from "@kingsleyweb/bun-jobs";
import process from "node:process";
import { noopLogger } from "@kingsleyweb/bun-common";
import { BunJobs } from "@kingsleyweb/bun-jobs";

const jobs = new BunJobs({
  namespace: process.env.NAMESPACE ?? "",
  driver: JSON.parse(process.env.DRIVER_CONFIG ?? "{}") as DriverConfig,
  publishEvents: true,
  logger: noopLogger,
});

// Adding a job is what creates the queue in the backend.
await jobs.queue("imports").add("import", { file: "a.csv" });
console.log("created");

/** The worker, once `run` has started it. */
let worker: BunQueueWorker | undefined;

for await (const line of console) {
  const command = line.trim();
  if (command === "run" && !worker) {
    const started = jobs.worker<unknown, unknown>("imports", async () => "ok", {
      pollInterval: 25,
      // Polls its instructions every 100ms where the driver cannot push them,
      // so the parent's remote pause lands quickly on every backend.
      remoteControl: { interval: 100 },
    });
    worker = started;
    void started.run();
    console.log("running");
  } else if (command === "exit") {
    break;
  }
}

await jobs.close();
process.exit(0);
