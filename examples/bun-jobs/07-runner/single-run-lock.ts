/**
 * The single-run lock — one run at a time across every instance of a runner.
 *
 * ```bash
 * bun 07-runner/single-run-lock.ts
 * EXAMPLE_DRIVER=redis EXAMPLE_REDIS_URL=redis://localhost:6379/13 bun 07-runner/single-run-lock.ts
 * ```
 *
 * Deploy a service with a scheduled runner to three hosts and, without a lock,
 * the 02:00 cleanup runs three times. In `runMode: "single"` (the default) a
 * run first takes a lock in the shared backend, renews it while it runs, and
 * releases it when done. An instance that finds the lock held either skips
 * (`lock-held`) or, with `queueRuns`, records the trigger for the lock holder
 * to run when it finishes.
 *
 * The three "hosts" here are three runner instances with three separate
 * driver connections to one backend — exactly what three processes would
 * have. (On the memory default a temporary SQLite file is used, because
 * separate memory drivers share nothing.)
 */
import type { LongTaskArgs } from "./handlers/long-task";
import { BunRunner, createDriver } from "@kingsleyweb/bun-jobs";
import { crossProcessDriver, exampleNamespace } from "../shared/backend";
import { show, step, title, waitFor } from "../shared/console";

title("Single-run lock");

const backend = crossProcessDriver();
const namespace = exampleNamespace("ops");

/** Builds one instance of the same runner, with its own connection. */
function instance(host: string, queueRuns: boolean) {
  const runner = new BunRunner<LongTaskArgs, string>({
    id: "nightly-cleanup", // the same id is what makes them the same runner
    namespace,
    file: new URL("./handlers/long-task.ts", import.meta.url),
    executionMode: "in-process",
    runMode: "single",
    queueRuns,
    lockTtl: 2_000, // the lock outlives a crashed holder by at most this
    args: { steps: 10, stepMs: 30 },
    driver: createDriver(backend), // an instance each: not shared, not closed by the runner
  });

  runner.on("started", (run) => {
    show(`${host}: started (${run.source})`);
  });
  runner.on("finished", (_run, result) => {
    show(`${host}: finished`, result);
  });
  return runner;
}

const hostA = instance("host-a", false);
const hostB = instance("host-b", false);
const hostC = instance("host-c", true);
await Promise.all([hostA.start(), hostB.start(), hostC.start()]);

/* ------------------------------------------------------------------ */
step("host-a triggers first and takes the lock");

show("host-a", await hostA.trigger());

const seenFromB = await hostB.info();
show("host-b's view of the runner", {
  isRunning: seenFromB.isRunning,
  runningOn: seenFromB.runningOn && {
    host: seenFromB.runningOn.host,
    pid: seenFromB.runningOn.pid,
  },
});

/* ------------------------------------------------------------------ */
step("host-b and host-c trigger while it runs");

show("host-b (queueRuns: false)", await hostB.trigger());
show("host-c (queueRuns: true)", await hostC.trigger());

// host-a, holding the lock, runs host-c's queued trigger when its own run ends.
await waitFor("the queued run to finish", async () => {
  return (await hostA.stats()).total === 2 && !(await hostA.info()).isRunning;
});

show(
  "history",
  (await hostA.history(5)).map((run) => `${run.source} → ${run.status}`),
);
show("shared stats (any instance reads the same)", await hostC.stats());

await Promise.all([hostA.stop(), hostB.stop(), hostC.stop()]);
await Promise.all([hostA, hostB, hostC].map((runner) => runner.driver.close()));
