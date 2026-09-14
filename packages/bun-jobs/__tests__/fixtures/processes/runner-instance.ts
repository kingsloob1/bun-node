import type { DriverConfig } from "./shared";
import process from "node:process";
import { BunRunner, createDriver, noopLogger } from "./shared";

/**
 * One runner instance, as a separate process.
 *
 * Everything it needs arrives through the environment, and everything it
 * reports goes to stdout as JSON lines, so the test sees this process's own
 * view of what happened rather than inferring it.
 */

const runner = new BunRunner({
  id: process.env.RUNNER_ID ?? "shared",
  namespace: process.env.NAMESPACE ?? "test",
  file: process.env.HANDLER_FILE ?? "",
  executionMode: "in-process",
  runMode: "single",
  queueRuns: process.env.QUEUE_RUNS === "1",
  // Any backend: the test decides, and the runner cannot tell the difference.
  driver: createDriver(
    process.env.DRIVER_CONFIG
      ? (JSON.parse(process.env.DRIVER_CONFIG) as DriverConfig)
      : { type: "file", root: process.env.DRIVER_ROOT ?? "" },
  ),
  waitToExit: false,
  logger: noopLogger,
  args: {
    marker: process.env.MARKER ?? "",
    log: process.env.RUN_LOG ?? "",
    ms: Number(process.env.RUN_MS ?? 100),
  },
});

const finished = new Promise<void>((resolve) => {
  runner.once("finished", () => resolve());
  runner.once("failed", () => resolve());
});

await runner.start();
const outcome = await runner.trigger();
console.log(JSON.stringify({ event: "trigger", outcome }));

if (outcome.outcome === "started") {
  await finished;
}

// Give the lock holder time to drain whatever the other process queued.
if (process.env.DRAIN_MS) {
  await Bun.sleep(Number(process.env.DRAIN_MS));
}

console.log(
  JSON.stringify({
    event: "done",
    stats: await runner.stats(),
    queued: (await runner.info()).queuedTriggers,
  }),
);

await runner.stop();
process.exit(0);
