import type { DriverConfig } from "./shared";
import { appendFileSync } from "node:fs";
import process from "node:process";
import { BunRunner, createDriver, noopLogger } from "./shared";

/**
 * A process that owns one runner and does nothing else, for another process
 * to control through `BunRunnerManager.controller()`.
 *
 * It never pauses, reschedules or triggers anything itself. Everything it
 * observes is appended to `EVENTS` as JSON lines, so the controlling test can
 * wait on what this process actually saw. `SIGTERM` stops it cleanly.
 */

const events = process.env.EVENTS ?? "";

/** Appends one observation for the test to read. */
function report(event: string, fields: Record<string, unknown> = {}): void {
  appendFileSync(
    events,
    `${JSON.stringify({ event, pid: process.pid, ...fields })}\n`,
  );
}

/** How this process reaches the backend, and how a child of it would. */
const driverConfig: DriverConfig = process.env.DRIVER_CONFIG
  ? (JSON.parse(process.env.DRIVER_CONFIG) as DriverConfig)
  : { type: "file", root: process.env.DRIVER_ROOT ?? "" };

const runner = new BunRunner<
  { marker?: string; log?: string; ms?: number },
  string
>({
  id: process.env.RUNNER_ID ?? "owned",
  namespace: process.env.NAMESPACE ?? "test",
  file: process.env.HANDLER_FILE ?? "",
  executionMode: "in-process",
  runMode: "single",
  schedule: 3_600_000,
  control: process.env.RUNNER_CONTROL === "1",
  ...(process.env.EXECUTION_MODES
    ? {
        allowedOverrides: {
          executionModes: process.env.EXECUTION_MODES.split(",") as (
            | "spawn"
            | "worker"
            | "in-process"
          )[],
        },
      }
    : {}),
  syncInterval: Number(process.env.SYNC_INTERVAL ?? 0),
  driver: createDriver(driverConfig),
  // A description of the same backend, so an override moving runs into a
  // child process is honoured rather than refused for want of one.
  childDriver: driverConfig,
  waitToExit: false,
  logger: noopLogger,
  args: { marker: "default", log: process.env.RUN_LOG ?? "", ms: 50 },
});

runner.on("paused", () => report("paused"));
runner.on("resumed", () => report("resumed"));
runner.on("configured", (config) => {
  report("configured", {
    executionMode: config.effective.executionMode,
    runMode: config.effective.runMode,
    maxConcurrency: config.effective.maxConcurrency,
    overridden: config.overridden,
    error: config.error?.message,
  });
});
runner.on("scheduled", () => {
  report("scheduled", { schedule: runner.schedule });
});
runner.on("finished", (record, result) => {
  report("finished", { source: record.source, result });
});
runner.on("error", (error, context) => {
  report("error", { message: error.message, context });
});

// Nothing else keeps an idle owner alive: the runner is told not to.
const hold = setInterval(() => {}, 1 << 30);

process.once("SIGTERM", () => {
  void (async () => {
    await runner.stop();
    report("stopped");
    clearInterval(hold);
    process.exit(0);
  })();
});

await runner.start();
report("ready");
