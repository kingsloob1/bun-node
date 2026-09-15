/**
 * The process that owns the runner in `remote-control.ts`. Started by that
 * example; everything arrives in the environment.
 *
 * It only starts the runner. Every pause, schedule change and run it goes
 * through comes from the other process. What it sees is printed as JSON
 * lines, so the parent can show the owner's own view.
 */
import type { DriverConfig } from "@kingsleyweb/bun-jobs";
import type { CleanupArgs, CleanupResult } from "../handlers/cleanup";
import process from "node:process";
import { BunRunner } from "@kingsleyweb/bun-jobs";

/** Prints one observation for the parent. */
function report(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, pid: process.pid, ...fields }));
}

const runner = new BunRunner<CleanupArgs, CleanupResult>({
  id: "nightly-cleanup",
  namespace: process.env.NAMESPACE ?? "remote-control",
  driver: JSON.parse(process.env.DRIVER_CONFIG ?? "{}") as DriverConfig,
  file: new URL("../handlers/cleanup.ts", import.meta.url),
  executionMode: "in-process",
  schedule: "0 2 * * *",
  args: { olderThanDays: 90 },
  // Hear control events as they are published, rather than every 30s.
  remoteControl: true,
  waitToExit: false,
});

runner.on("paused", () => report("paused"));
runner.on("resumed", () => report("resumed"));
runner.on("scheduled", (next) => {
  report("scheduled", { schedule: runner.schedule, next });
});
runner.on("finished", (record, result) => {
  report("finished", { source: record.source, result });
});

// The runner does not hold the process open (`waitToExit: false`); this does,
// until the parent sends SIGTERM.
const hold = setInterval(() => {}, 1 << 30);

process.once("SIGTERM", () => {
  void runner.stop().then(() => {
    clearInterval(hold);
    process.exit(0);
  });
});

await runner.start();
report("ready");
