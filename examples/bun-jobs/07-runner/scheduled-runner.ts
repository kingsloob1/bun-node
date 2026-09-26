/**
 * A scheduled runner — run a file on an interval or cron, and read its
 * history and counters.
 *
 * ```bash
 * bun 07-runner/scheduled-runner.ts
 * ```
 *
 * `BunRunner` is the other half of bun-jobs: not a queue of many small jobs,
 * but *one* piece of work — a file — run on a schedule or on demand. Think
 * cron jobs, done properly: a run can time out, be killed, report progress,
 * and by default only one run happens at a time across the whole cluster.
 *
 * `schedule` accepts a cron string (five fields, or six with seconds), an
 * interval in milliseconds, a `Date` (once), `{ cron, tz }`,
 * `{ every, anchor }` or `{ at }`. Leave it out for a runner driven only by
 * `trigger()`.
 */
import type { CleanupArgs, CleanupResult } from "./handlers/cleanup";
import { BunRunner } from "@kingsleyweb/bun-jobs";
import { exampleDriver, exampleNamespace } from "../shared/backend";
import { show, step, title, waitFor } from "../shared/console";

title("Scheduled runner");

const runner = new BunRunner<CleanupArgs, CleanupResult>({
  id: "cleanup",
  name: "Nightly cleanup",
  namespace: exampleNamespace("ops"),
  file: new URL("./handlers/cleanup.ts", import.meta.url),
  schedule: 400, // every 400ms, for the demo
  // Run in this process. `child-process` (the default) isolates each run in a child
  // process; see execution-modes.ts.
  executionMode: "in-process",
  args: { olderThanDays: 30 }, // default arguments for scheduled runs
  timeout: 10_000, // per run
  keepHistory: 20, // run records kept in the backend
  driver: exampleDriver(),
});

let finished = 0;
runner.on("scheduled", (next) => {
  show("next run", next?.toISOString() ?? "none");
});
runner.on("started", (run) => {
  show(`run ${run.runId.slice(-8)} started`, `source: ${run.source}`);
});
runner.on("progress", (run, value) => {
  show(`run ${run.runId.slice(-8)} progress`, value);
});
runner.on("finished", (run, result) => {
  finished++;
  show(`run ${run.runId.slice(-8)} finished in ${run.durationMs}ms`, result);
});
runner.on("failed", (run, error) => {
  show(`run ${run.runId.slice(-8)} failed`, error.message);
});

/* ------------------------------------------------------------------ */
step("start(): arm the schedule");

await runner.start();
await waitFor("three scheduled runs", () => finished === 3);

/* ------------------------------------------------------------------ */
step("updateSchedule(): switch to cron — every second, on the second");

// Persisted to the backend, so every instance of this runner picks it up.
await runner.updateSchedule("* * * * * *");
show("schedule", runner.schedule);
await waitFor("one cron run", () => finished === 4);

/* ------------------------------------------------------------------ */
step("history(), stats() and info()");

await runner.pause(); // stop firing while we read

show(
  "history (newest first)",
  (await runner.history(5)).map((run) => ({
    run: run.runId.slice(-8),
    source: run.source,
    status: run.status,
    durationMs: run.durationMs,
    result: run.result,
  })),
);
show("stats", await runner.stats());

const info = await runner.info();
show("info", {
  status: info.status,
  isPaused: info.isPaused,
  isRunning: info.isRunning,
  schedule: info.schedule,
  lastRun: info.lastRun?.status,
});

await runner.stop();
show("stopped");
