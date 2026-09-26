/**
 * Talking to a running handler — progress, logs, messages, timeouts and kill.
 *
 * ```bash
 * bun 07-runner/messages-progress-kill.ts
 * ```
 *
 * The handler runs in a child process (`child-process`), so everything here crosses a
 * process boundary: `ctx.progress()` → `progress` event, `ctx.send()` →
 * `message` event, `ctx.logger` → `log` event (with `forwardLogs`), and
 * `runner.send()` → `ctx.onMessage`.
 *
 * Stopping a run escalates: the handler's signal is aborted and it has
 * `closeTimeout` to return; then `SIGTERM`, and `killTimeout` later `SIGKILL`.
 * A handler that checks its signal never reaches the signals.
 */
import type { LongTaskArgs } from "./handlers/long-task";
import { BunRunner } from "@kingsleyweb/bun-jobs";
import { exampleNamespace } from "../shared/backend";
import { show, step, title, waitFor } from "../shared/console";

title("Messages, progress, timeouts and kill");

const runner = new BunRunner<LongTaskArgs, string>({
  id: "reindex",
  namespace: exampleNamespace("search"),
  file: new URL("./handlers/long-task.ts", import.meta.url),
  executionMode: "child-process",
  runMode: "parallel",
  forwardLogs: true,
  closeTimeout: 1_000, // grace after the signal, before SIGTERM
  killTimeout: 1_000, // grace after SIGTERM, before SIGKILL
});

runner.on("progress", (run, value) => {
  show(`[${run.runId.slice(-6)}] progress`, `${value}%`);
});
runner.on("message", (run, data) => {
  show(`[${run.runId.slice(-6)}] message from the child`, data);
});
runner.on("log", (run, level, message, fields) => {
  show(`[${run.runId.slice(-6)}] child log (${level})`, { message, fields });
});

/** Every run's outcome, by run id. */
const outcomes = new Map<string, string>();
runner.on("finished", (run, result) => {
  outcomes.set(run.runId, `finished: ${result}`);
});
runner.on("failed", (run, error) => {
  outcomes.set(run.runId, `failed: ${error.message}`);
});
runner.on("timeout", (run) => {
  show(`[${run.runId.slice(-6)}] timed out`);
});
runner.on("killed", (run, reason) => {
  show(`[${run.runId.slice(-6)}] killed`, reason);
});

await runner.start();

/** Triggers a run and answers with its id. */
async function start(args: LongTaskArgs): Promise<string> {
  const outcome = await runner.trigger({ args });
  if (outcome.outcome !== "started")
    throw new Error(`not started: ${outcome.outcome}`);
  return outcome.runId;
}

/* ------------------------------------------------------------------ */
step("Progress, and a conversation with the child");

const chatty = await start({ steps: 10, stepMs: 60 });
await Bun.sleep(250);
runner.send("status", chatty); // answered with a `message` event
await Bun.sleep(150);
runner.send("wrap up", chatty); // the handler returns early
await waitFor("the chatty run", () => outcomes.has(chatty));
show("outcome", outcomes.get(chatty));

/* ------------------------------------------------------------------ */
step("kill(): abort a run from outside");

const doomed = await start({ steps: 100, stepMs: 50 });
await Bun.sleep(300);
await runner.kill(doomed, { reason: "operator cancelled" });
await waitFor("the killed run", () => outcomes.has(doomed));
show("outcome", outcomes.get(doomed));

/* ------------------------------------------------------------------ */
step("timeout: a run that outlives the runner's timeout is stopped");

const timed = new BunRunner<LongTaskArgs, string>({
  id: "reindex-with-timeout",
  namespace: exampleNamespace("search"),
  file: new URL("./handlers/long-task.ts", import.meta.url),
  executionMode: "child-process",
  timeout: 300,
});
const timedOut = new Promise<void>((resolve) => {
  timed.once("timeout", (run) => {
    show(`[${run.runId.slice(-6)}] exceeded its 300ms timeout`);
    resolve();
  });
});
await timed.start();
await timed.trigger({ args: { steps: 100, stepMs: 50 } });
await timedOut;

await waitFor("the timed-out run to be recorded", async () => {
  return (await timed.stats()).timeout === 1;
});
show("stats", await timed.stats());
show(
  "last run",
  (await timed.history(1)).map((run) => ({
    status: run.status,
    error: run.error?.message,
  })),
);

await timed.stop();
await runner.stop();
