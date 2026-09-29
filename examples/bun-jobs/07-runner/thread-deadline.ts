/**
 * A `worker-thread` run the runner ends is over only once its thread is.
 *
 * ```bash
 * bun 07-runner/thread-deadline.ts
 * EXAMPLE_DRIVER=redis EXAMPLE_REDIS_URL=redis://127.0.0.1:6379/13 bun 07-runner/thread-deadline.ts
 * ```
 *
 * On Bun, `Worker.terminate()` returns before a busy thread stops: the thread
 * runs on for tens of milliseconds, and for up to a couple of seconds on a
 * loaded machine (oven-sh/bun#44216). So when a timeout, `kill()` or `stop()`
 * ends a `worker-thread` run, the runner does not report it ended until its
 * thread has actually stopped. Until then the run stays in `activeRuns`, its
 * record says `running`, it keeps the lock, and nothing is written or emitted.
 *
 * The handler here (`handlers/busy-heartbeat.ts`) never yields, and writes a
 * heartbeat to a file on every turn. Each step reads the heartbeat the moment
 * the runner says the run is over, waits until the file stops changing, and
 * reads it again: the two must be the same.
 *
 * The points that are easy to get wrong:
 *
 * - **The wait is capped at 500 ms.** A thread still running then is left to
 *   stop on its own, and the runner logs one `warn` naming the run
 *   (`fields.runId`). On a starved machine that is the documented outcome,
 *   not a bug, so each "heartbeat still" check accepts that warning for its
 *   own run instead.
 * - **`durationMs` includes the wait.** A timed-out run reads at least its
 *   `timeout`, and up to 500 ms past it.
 * - **Only an ending the runner imposed waits.** A handler that returns is
 *   recorded `success` at once, however long its thread takes to go;
 *   `stop()` is what waits for that thread, capped the same way.
 */
import type { RunRecord } from "@kingsleyweb/bun-jobs";
import type { BusyHeartbeatArgs } from "./handlers/busy-heartbeat";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestLogger } from "@kingsleyweb/bun-common";
import { BunRunner } from "@kingsleyweb/bun-jobs";
import { exampleDriver, exampleNamespace, tempDir } from "../shared/backend";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";

title("A worker-thread run ends when its thread does");

// No `RUN_ALONE` entry in `run-all.ts`: nothing here asserts a duration. What
// CPU starvation can do is keep a thread running past the runner's 500 ms cap,
// and then the runner's answer is the warning below, which the checks accept
// for the run it names. A heartbeat still moving *without* that warning fails
// whatever the load, and that is the bug this example exists to catch.

const namespace = exampleNamespace("thread-deadline");
const config = exampleDriver();
const beats = tempDir("thread-deadline");
const handler = new URL("./handlers/busy-heartbeat.ts", import.meta.url);

/** Every runner's log, so the reap warning can be looked for by run id. */
const { logger, events } = createTestLogger();

/** Generous ceiling for anything a busy machine might slow down. */
const WAIT = { timeout: 30_000, interval: 5 };

/** The handler spins for this long unless it is ended first: a minute. */
const FOREVER = 60_000;

/**
 * The runner's warnings that it stopped waiting for `runId`'s thread
 * (oven-sh/bun#44216). The message is static; the run is in its fields.
 */
function reapWarnings(runId: string) {
  return events.filter(
    (event) =>
      event.level === "warn" &&
      event.message.includes("44216") &&
      event.fields.runId === runId,
  );
}

/** A fresh heartbeat file for one run. */
let beaconCount = 0;
function beaconFile(): string {
  beaconCount++;
  return join(beats, `beat-${beaconCount}`);
}

/** The heartbeat as it is now, read synchronously; `""` before the first beat. */
function beat(file: string): string {
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

/**
 * Reads the heartbeat until it has not changed for 300 ms, for 10 s at most:
 * the last beat the thread wrote, and whether it stopped at all.
 */
async function lastBeat(
  file: string,
): Promise<{ value: string; stopped: boolean }> {
  const deadline = Date.now() + 10_000;
  let value = beat(file);
  let since = Date.now();
  while (Date.now() < deadline) {
    await Bun.sleep(15);
    const next = beat(file);
    if (next !== value) {
      value = next;
      since = Date.now();
    } else if (Date.now() - since >= 300) {
      return { value, stopped: true };
    }
  }
  return { value, stopped: false };
}

/**
 * The claim each step makes: the heartbeat read when the runner said the run
 * was over is the thread's last. Or, the documented alternative, the thread
 * outlived the 500 ms cap and the runner said so, once, for this run.
 */
async function checkStill(
  label: string,
  runId: string,
  file: string,
  atEnd: string,
  endedAt: number,
): Promise<string> {
  const last = await lastBeat(file);
  check(`${label}: the thread stopped (not left running)`, last.stopped, last);
  check(`${label}: a heartbeat was written`, Number(last.value) > 0, last);

  const warned = reapWarnings(runId);
  if (warned.length > 0) {
    show(
      `${label}: the thread outlived the 500 ms cap; the runner warned`,
      warned[0]!.fields,
    );
  } else if (Number(last.value) > 0) {
    const gap = endedAt - Number(last.value);
    show(
      `${label}: the thread's last beat`,
      `${Math.abs(gap).toFixed(1)}ms ${gap >= 0 ? "before" : "AFTER"} the run was reported ended`,
    );
  }
  check(
    `${label}: heartbeat unchanged since the run was reported ended (or the reap warning names this run)`,
    atEnd === last.value || warned.length === 1,
    { atEnd, last: last.value, warnings: warned.length },
  );
  return last.value;
}

/** The heartbeat's clock: one origin the parent and its threads share. */
function now(): number {
  return performance.timeOrigin + performance.now();
}

/** Triggers `runner` and answers with the run's id and handle. */
async function startRun(
  runner: BunRunner<BusyHeartbeatArgs, string>,
  args: BusyHeartbeatArgs,
): Promise<{ runId: string; done: Promise<string> }> {
  const outcome = await runner.trigger({ args });
  if (outcome.outcome !== "started") {
    throw new Error(`not started: ${outcome.outcome}`);
  }
  const handle = runner.activeRuns.get(outcome.runId);
  if (!handle) {
    throw new Error(`run ${outcome.runId} is not in activeRuns`);
  }
  return { runId: outcome.runId, done: handle.done };
}

/** The history row for `runId`. */
async function row(
  runner: BunRunner<BusyHeartbeatArgs, string>,
  runId: string,
): Promise<RunRecord | undefined> {
  return (await runner.history(10)).find((run) => run.runId === runId);
}

/** The timed run's timeout: long enough for its thread to boot and beat first. */
const TIMEOUT = 4_000;

/** The heartbeat read synchronously inside each event, by run id. */
const atEvent = new Map<string, string>();
/** Which ending events fired, by run id. */
const endings = new Map<string, string[]>();
/** The beacon file of each run, so an event listener can read it. */
const beaconOf = new Map<string, string>();

/**
 * A started `worker-thread` runner of the busy handler, whose `timeout` and
 * `killed` events record the heartbeat at the moment they fire.
 */
async function busyRunner(
  id: string,
  timeout?: number,
): Promise<BunRunner<BusyHeartbeatArgs, string>> {
  const runner = new BunRunner<BusyHeartbeatArgs, string>({
    id,
    namespace,
    file: handler,
    executionMode: "worker-thread",
    driver: config, // a config, so the runner closes the driver it builds
    logger,
    ...(timeout === undefined ? {} : { timeout }),
    // The handler never reads its signal, so the grace after `close` is
    // wasted: the runner terminates the thread once it runs out.
    closeTimeout: 100,
  });

  runner.on("timeout", (run) => {
    atEvent.set(run.runId, beat(beaconOf.get(run.runId) ?? ""));
    endings.set(run.runId, [...(endings.get(run.runId) ?? []), "timeout"]);
  });
  runner.on("killed", (run, reason) => {
    atEvent.set(run.runId, beat(beaconOf.get(run.runId) ?? ""));
    endings.set(run.runId, [
      ...(endings.get(run.runId) ?? []),
      `killed: ${reason}`,
    ]);
  });

  await runner.start();
  return runner;
}

/* ------------------------------------------------------------------ */
step(`A busy run given a ${TIMEOUT} ms timeout`);

{
  const timed = await busyRunner("timed-thread", TIMEOUT);
  const file = beaconFile();
  const { runId, done } = await startRun(timed, {
    beaconFile: file,
    spinMs: FOREVER,
  });
  beaconOf.set(runId, file);

  const status = await done;
  const atEnd = beat(file);
  const endedAt = now();
  checkEqual("the run ends 'timeout'", status, "timeout");
  check("then it has left activeRuns", !timed.activeRuns.has(runId));

  const record = await row(timed, runId);
  checkEqual("its history row says 'timeout'", record?.status, "timeout");
  checkEqual("the timeout event fired once", endings.get(runId), ["timeout"]);
  check(
    "the handler was beating when the timeout came",
    Number(atEvent.get(runId)) > 0,
    { atEvent: atEvent.get(runId) },
  );

  // At least the timeout. Not at most: the runner waited for the thread to
  // stop before recording the run, so `durationMs` includes `closeTimeout`
  // and that wait, and can read up to 500 ms past the timeout.
  check(
    `durationMs is at least the ${TIMEOUT} ms timeout`,
    (record?.durationMs ?? 0) >= TIMEOUT,
    { durationMs: record?.durationMs },
  );
  show("durationMs", record?.durationMs);

  const timeoutFinal = await checkStill("timeout", runId, file, atEnd, endedAt);
  // Against the thread's final beat, not a read a moment after the event: a
  // thread still running when the event fired beats again later.
  check(
    "the heartbeat was already still when the timeout event fired (or the reap warning names this run)",
    atEvent.get(runId) === timeoutFinal || reapWarnings(runId).length === 1,
    { atEvent: atEvent.get(runId), final: timeoutFinal },
  );
  await timed.stop();
}

/* ------------------------------------------------------------------ */
step("kill(): a busy run, killed");

/** The runner of the next two steps: no timeout, so only they end its runs. */
const busy = await busyRunner("busy-thread");

{
  const file = beaconFile();
  const { runId, done } = await startRun(busy, {
    beaconFile: file,
    spinMs: FOREVER,
  });
  beaconOf.set(runId, file);
  await waitFor("the handler to start beating", () => beat(file) !== "", WAIT);

  await busy.kill(runId, { reason: "operator cancelled" });
  const atEnd = beat(file);
  const endedAt = now();

  check(
    "once kill() resolves, the run has left activeRuns",
    !busy.activeRuns.has(runId),
  );
  checkEqual("its done says 'killed'", await done, "killed");
  checkEqual(
    "its history row says 'killed'",
    (await row(busy, runId))?.status,
    "killed",
  );
  checkEqual(
    "the killed event fired once, with the reason",
    endings.get(runId),
    ["killed: operator cancelled"],
  );

  const killFinal = await checkStill("kill()", runId, file, atEnd, endedAt);
  check(
    "the heartbeat was already still when the killed event fired (or the reap warning names this run)",
    atEvent.get(runId) === killFinal || reapWarnings(runId).length === 1,
    { atEvent: atEvent.get(runId), final: killFinal },
  );
}

/* ------------------------------------------------------------------ */
step("stop() with a busy run in flight");

{
  const file = beaconFile();
  const { runId, done } = await startRun(busy, {
    beaconFile: file,
    spinMs: FOREVER,
  });
  beaconOf.set(runId, file);
  await waitFor("the handler to start beating", () => beat(file) !== "", WAIT);

  let stopped = 0;
  busy.on("stopped", () => stopped++);
  // Give the run 100 ms to finish, then kill it.
  await busy.stop({ timeout: 100 });
  const atEnd = beat(file);
  const endedAt = now();

  checkEqual("the runner is stopped", busy.status, "stopped");
  checkEqual("no run is left in activeRuns", busy.activeRuns.size, 0);
  checkEqual("the stopped event fired once", stopped, 1);
  checkEqual("the run's done says 'killed'", await done, "killed");
  checkEqual(
    "the killed event fired once, with the reason",
    endings.get(runId),
    ["killed: stop"],
  );

  await checkStill("stop()", runId, file, atEnd, endedAt);
}

/* ------------------------------------------------------------------ */
step("The contrast: a handler that returns is recorded at once");

{
  const returning = new BunRunner<BusyHeartbeatArgs, string>({
    id: "returning-thread",
    namespace,
    file: handler,
    executionMode: "worker-thread",
    driver: config,
    logger,
  });

  /** Whether a reap warning existed for the run when `finished` fired. */
  let warnedAtFinish: boolean | undefined;
  let result: string | undefined;
  returning.on("finished", (run, value) => {
    warnedAtFinish = reapWarnings(run.runId).length > 0;
    result = value;
  });
  await returning.start();

  // It spins until released, returns, and then blocks its thread for a
  // second in a native wait nothing can interrupt: the run is over well
  // before the thread is.
  const file = beaconFile();
  const releaseFile = `${file}.release`;
  const markerFile = `${file}.blocked`;
  const { runId, done } = await startRun(returning, {
    beaconFile: file,
    spinMs: FOREVER,
    releaseFile,
    linger: { ms: 1_000, markerFile },
  });
  await waitFor("the handler to start beating", () => beat(file) !== "", WAIT);

  // Released, and then this thread is held still, synchronously, until the
  // handler's thread is inside its wait. Nothing below can run meanwhile, so
  // the runner can neither read the result nor terminate the thread before
  // the thread has blocked. Without that, a terminate() landing first would
  // leave no slow thread to show. A deadline, not a guess at how long.
  writeFileSync(releaseFile, "go");
  const deadline = Date.now() + WAIT.timeout;
  while (!existsSync(markerFile) && Date.now() < deadline) {
    Bun.sleepSync(1);
  }
  check(
    "the handler returned, and its thread is now blocked",
    existsSync(markerFile),
  );

  checkEqual("the run ends 'success'", await done, "success");
  checkEqual("with the handler's result", result, "returned");
  checkEqual(
    "its history row says 'success'",
    (await row(returning, runId))?.status,
    "success",
  );
  // Had the runner held the result for the thread, it would have waited out
  // the 500 ms cap first, and warned before recording anything.
  checkEqual(
    "it was recorded without waiting for the thread (no reap warning yet)",
    warnedAtFinish,
    false,
  );

  // `stop()` does wait for that thread, capped, and says so when it gives up.
  await returning.stop();
  checkEqual(
    "stop() waited for the lingering thread, gave up at the cap and warned once",
    reapWarnings(runId).length,
    1,
  );
  show("the warning", reapWarnings(runId)[0]?.message);
}

summary();
