/**
 * Graceful shutdown — the signal handling every worker service needs.
 *
 * ```bash
 * bun 09-integrations/graceful-shutdown.ts          # sends itself SIGTERM mid-work
 * bun 09-integrations/graceful-shutdown.ts --serve  # runs until you press Ctrl+C
 * ```
 *
 * A deploy, an autoscaler or `docker stop` sends `SIGTERM` and, after a grace
 * period (10s for Docker, 30s by default on Kubernetes), `SIGKILL`. In between
 * a worker should stop claiming, finish what it holds, and close its
 * connections. `jobs.close({ timeout })` is exactly that, for every worker and
 * runner the context created.
 *
 * Set `timeout` below the platform's grace period. A job still running when
 * it expires has its signal aborted and its lock left to lapse; another worker
 * then recovers it. Nothing is lost either way — but a clean finish is faster
 * than a recovery.
 */
import process from "node:process";
import { BunJobs, BunQueue, createDriver } from "@kingsleyweb/bun-jobs";
import { crossProcessDriver, exampleNamespace } from "../shared/backend";
import { show, title } from "../shared/console";

title("Graceful shutdown");

// An instance rather than a config, so it is ours to close — after reporting
// what was left once `jobs.close()` has stopped everything else.
const driver = createDriver(crossProcessDriver());

const jobs = new BunJobs({
  namespace: exampleNamespace("worker-service"),
  driver,
});

let started = 0;
let finished = 0;

jobs.define<{ n: number }>("resizeImage", async (job, ctx) => {
  started++;
  // 300ms of work that stops early if the attempt is aborted.
  for (let step = 0; step < 6; step++) {
    ctx.signal.throwIfAborted();
    await Bun.sleep(50);
  }
  finished++;
  return job.data.n;
});

for (let n = 0; n < 20; n++) {
  await jobs.now("resizeImage", { n });
}

await jobs.start({ concurrency: 4, pollInterval: 25 });
show("worker started; 20 jobs queued");

// Nothing else is needed to keep the service up while the queue is idle: a
// running worker holds the process open (`waitToExit`, on by default), and
// `jobs.close()` holds it until shutdown has fully settled.

let shuttingDown = false;

/** Stops taking work, finishes what is in hand, and exits. */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return; // a second Ctrl+C should not start a second close
  shuttingDown = true;

  show(`${signal} received`, `${started - finished} job(s) in flight`);
  const began = performance.now();

  await jobs.close({ timeout: 8_000 });
  show(`closed in ${Math.round(performance.now() - began)}ms`, {
    startedHere: started,
    finishedHere: finished,
  });

  // The context's queues are closed now; a fresh one reads what is left.
  const registry = new BunQueue("jobs", { namespace: jobs.namespace, driver });
  show("left waiting for the next instance", await registry.count("waiting"));

  await registry.close();
  await driver.close();
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

if (!process.argv.includes("--serve")) {
  // Simulate the orchestrator: stop us while jobs are mid-flight.
  setTimeout(() => process.kill(process.pid, "SIGTERM"), 450);
}
