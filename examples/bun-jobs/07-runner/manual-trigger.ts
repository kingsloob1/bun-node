/**
 * Triggering a runner on demand — and what happens when it is busy.
 *
 * ```bash
 * bun 07-runner/manual-trigger.ts
 * ```
 *
 * `trigger()` never throws for an ordinary refusal; it says what it did:
 *
 * - `{ outcome: "started", runId }`
 * - `{ outcome: "queued", position }`  — busy, and `queueRuns` is on
 * - `{ outcome: "skipped", reason }`   — `paused`, `busy`, `lock-held`,
 *   `max-concurrency`, `queue-full` or `stopped`
 *
 * `runMode: "single"` (the default) allows one run at a time, cluster-wide.
 * `runMode: "parallel"` allows overlap, bounded by `maxConcurrency`.
 */
import type { LongTaskArgs } from "./handlers/long-task";
import { BunRunner, RunnerStoppedError } from "@kingsleyweb/bun-jobs";
import { exampleDriver, exampleNamespace } from "../shared/backend";
import { show, step, title, waitFor } from "../shared/console";

title("Manual triggers");

const namespace = exampleNamespace("exports");
const file = new URL("./handlers/long-task.ts", import.meta.url);

/* ------------------------------------------------------------------ */
step("single mode + queueRuns: one at a time, the rest wait their turn");

const single = new BunRunner<LongTaskArgs, string>({
  id: "rebuild-search-index",
  namespace,
  file,
  executionMode: "in-process",
  runMode: "single",
  queueRuns: true,
  maxQueuedRuns: 10,
  args: { steps: 5, stepMs: 20 },
  driver: exampleDriver(),
});

const results: string[] = [];
single.on("finished", (run, result) => {
  results.push(`${run.source}: ${result}`);
});
await single.start();

show("trigger #1", await single.trigger());
show("trigger #2", await single.trigger({ args: { steps: 2, stepMs: 20 } }));
show("trigger #3", await single.trigger());

await waitFor("all three runs", () => results.length === 3);
show("finished, in order", results);

/* ------------------------------------------------------------------ */
step("paused: triggers are skipped unless forced");

await single.pause();
show("while paused", await single.trigger());
show("forced", await single.trigger({ force: true }));
await waitFor("the forced run", () => results.length === 4);

await single.stop();
try {
  await single.trigger();
} catch (error) {
  if (!(error instanceof RunnerStoppedError)) throw error;
  show("after stop()", `${error.name}: ${error.message}`);
}

/* ------------------------------------------------------------------ */
step("parallel mode: runs overlap, up to maxConcurrency");

const parallel = new BunRunner<LongTaskArgs, string>({
  id: "thumbnails",
  namespace,
  file,
  executionMode: "in-process",
  runMode: "parallel",
  maxConcurrency: 2,
  args: { steps: 5, stepMs: 20 },
  driver: exampleDriver(),
});
await parallel.start();

const outcomes = [];
for (let index = 0; index < 3; index++) {
  outcomes.push(await parallel.trigger());
}
show(
  "three triggers at once",
  outcomes.map((outcome) => outcome.outcome),
);
show(
  "running now",
  [...parallel.activeRuns.keys()].map((id) => id.slice(-8)),
);

await waitFor("the parallel runs", () => parallel.activeRuns.size === 0);
show("stats", await parallel.stats());
await parallel.stop();
