/**
 * Option tour: `BunRunner`, `RunContext` and `BunRunnerManager` — every
 * option set, every member called, every behaviour asserted.
 *
 * ```bash
 * bun 10-options/runner-options.ts
 * EXAMPLE_DRIVER=redis EXAMPLE_REDIS_URL=redis://127.0.0.1:6379/13 bun 10-options/runner-options.ts
 * ```
 *
 * The points that are easy to get wrong:
 *
 * - **Nothing starts in the constructor** unless `autostart` says so.
 * - **`single` mode is a lock in the driver**, so a second instance of the
 *   same id is a second host: it sees `lock-held`, and a queued trigger is
 *   drained by whoever holds the lock. `parallel` takes no lock at all.
 * - **A lost lock is only noticed at a heartbeat.** A lock that lapses between
 *   renewals is not detected until the next one fails — so `heartbeatInterval`
 *   is also the upper bound on how long two runs may overlap.
 * - **Escalation is `close` → `SIGTERM` → `SIGKILL`**, `closeTimeout` then
 *   `killTimeout` apart. A cooperative handler returns before either signal;
 *   a child blocking its event loop gets `SIGTERM`; one that also ignores it
 *   gets `SIGKILL`. `force` goes straight to `SIGKILL`.
 * - **`maxResultBytes` bounds what is stored**, not what the `finished` event
 *   carries: an oversize result is replaced in history by a
 *   `{ __truncated, bytes, preview }` marker.
 * - **`worker.smol` and `worker.name`** cannot be observed from inside a
 *   Worker; they are passed through and checked on the resolved options.
 */
import type { BunRunnerOptions, RunRecord } from "@kingsleyweb/bun-jobs";
import type { BigResult, BigResultArgs } from "./handlers/runner-big-result";
import type { BlockingArgs } from "./handlers/runner-blocking";
import type { ContextArgs, ContextReport } from "./handlers/runner-context";
import type { WorkArgs, WorkResult } from "./handlers/runner-work";
import { chmodSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { createTestLogger, noopLogger } from "@kingsleyweb/bun-common";
import {
  BunRunner,
  BunRunnerManager,
  createDriver,
  JobsNotifier,
} from "@kingsleyweb/bun-jobs";
import { exampleDriver, exampleNamespace, tempDir } from "../shared/backend";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";

title("Option tour: BunRunner");

/** Generous ceiling for anything a busy machine might slow down. */
const WAIT = { timeout: 30_000, interval: 10 };

const namespace = exampleNamespace("runner-options");
const config = exampleDriver();
/** One connection most runners share, so separate instances are separate hosts. */
const shared = createDriver(config);
await shared.connect();

const handlersDir = join(import.meta.dir, "handlers");

/** A handler file in `./handlers`. */
function handler(name: string): URL {
  return new URL(`./handlers/${name}.ts`, import.meta.url);
}

/* ------------------------------------------------------------------ *
 * Helpers: every event a runner emits, recorded, and runs waited on.
 * ------------------------------------------------------------------ */

/** Everything one runner emitted, in order. */
interface Tracker<TResult> {
  /** `scheduled` payloads. */
  scheduled: (Date | null)[];
  /** `started` records. */
  started: RunRecord[];
  /** `progress` values. */
  progress: unknown[];
  /** `message` payloads. */
  messages: unknown[];
  /** `log` events. */
  logs: { level: string; message: string; fields: unknown }[];
  /** `output` chunks, joined per stream. */
  output: { stdout: string; stderr: string };
  /** `finished` records and results. */
  finished: { record: RunRecord; result: TResult }[];
  /** `failed` records and errors. */
  failed: { record: RunRecord; error: Error }[];
  /** `timeout` records. */
  timeouts: RunRecord[];
  /** `killed` records and reasons. */
  killed: { record: RunRecord; reason: string }[];
  /** `skipped` reasons. */
  skipped: string[];
  /** `queued` trigger args. */
  queued: unknown[];
  /** `dequeued` trigger args. */
  dequeued: unknown[];
  /** `lockLost` records. */
  lockLost: RunRecord[];
  /** How many `paused` events. */
  paused: number;
  /** How many `resumed` events. */
  resumed: number;
  /** How many `stopped` events. */
  stopped: number;
}

/** A runner with its tracker. */
interface Tracked<TArgs, TResult> {
  /** The runner. */
  runner: BunRunner<TArgs, TResult>;
  /** What it emitted. */
  t: Tracker<TResult>;
}

/** Records every event except `error` (whose listener changes behaviour). */
function track<TArgs, TResult>(
  runner: BunRunner<TArgs, TResult>,
): Tracker<TResult> {
  const t: Tracker<TResult> = {
    scheduled: [],
    started: [],
    progress: [],
    messages: [],
    logs: [],
    output: { stdout: "", stderr: "" },
    finished: [],
    failed: [],
    timeouts: [],
    killed: [],
    skipped: [],
    queued: [],
    dequeued: [],
    lockLost: [],
    paused: 0,
    resumed: 0,
    stopped: 0,
  };

  runner.on("scheduled", (next) => t.scheduled.push(next));
  runner.on("started", (record) => t.started.push(record));
  runner.on("progress", (_record, value) => t.progress.push(value));
  runner.on("message", (_record, data) => t.messages.push(data));
  runner.on("log", (_record, level, message, fields) => {
    t.logs.push({ level, message, fields });
  });
  runner.on("output", (_record, stream, chunk) => {
    t.output[stream] += chunk;
  });
  runner.on("finished", (record, result) => {
    t.finished.push({ record, result });
  });
  runner.on("failed", (record, error) => t.failed.push({ record, error }));
  runner.on("timeout", (record) => t.timeouts.push(record));
  runner.on("killed", (record, reason) => t.killed.push({ record, reason }));
  runner.on("skipped", (outcome) => t.skipped.push(outcome.reason));
  runner.on("queued", (trigger) => t.queued.push(trigger.args));
  runner.on("dequeued", (trigger) => t.dequeued.push(trigger.args));
  runner.on("lockLost", (record) => t.lockLost.push(record));
  runner.on("paused", () => t.paused++);
  runner.on("resumed", () => t.resumed++);
  runner.on("stopped", () => t.stopped++);

  return t;
}

/** Every runner created here, so the end of the tour can stop what is left. */
const created: BunRunner<any, any>[] = [];

/**
 * A tracked runner in the tour's namespace: the work handler, in-process, on
 * the shared driver, silent — unless the options say otherwise.
 */
function makeRunner<TArgs = WorkArgs, TResult = WorkResult>(
  options: Omit<BunRunnerOptions<NoInfer<TArgs>>, "namespace" | "file"> & {
    /** Defaults to the work handler. */
    file?: string | URL;
    /** Defaults to the tour's namespace. */
    namespace?: string;
  },
): Tracked<TArgs, TResult> {
  const runner = new BunRunner<TArgs, TResult>({
    namespace,
    file: handler("runner-work"),
    executionMode: "in-process",
    driver: shared,
    logger: noopLogger,
    ...options,
  });
  created.push(runner);
  return { runner, t: track(runner) };
}

/** The run id a trigger started, or a failed check and `""`. */
function startedId(
  label: string,
  outcome: Awaited<ReturnType<BunRunner["trigger"]>>,
): string {
  check(`${label}: started`, outcome.outcome === "started", outcome);
  return outcome.outcome === "started" ? outcome.runId : "";
}

/** Waits for a run to settle — `finished` or `failed` — and returns its record. */
async function settle<TResult>(
  t: Tracker<TResult>,
  runId: string,
): Promise<RunRecord> {
  let record: RunRecord | undefined;
  await waitFor(
    `run ${runId} to settle`,
    () => {
      record =
        t.finished.find((entry) => entry.record.runId === runId)?.record ??
        t.failed.find((entry) => entry.record.runId === runId)?.record;
      return record !== undefined;
    },
    WAIT,
  );
  return record!;
}

/* ------------------------------------------------------------------ */
step("Defaults, and what is rejected at construction");

{
  const bare = new BunRunner({
    id: "defaults",
    namespace,
    file: handler("runner-work"),
  });
  const { options } = bare;

  checkEqual("nothing starts in the constructor", bare.status, "idle");
  checkEqual("name defaults to the id", bare.name, "defaults");
  check(
    "file is resolved to an absolute path",
    options.file.startsWith("/"),
    options.file,
  );
  checkEqual(
    "documented defaults",
    {
      executionMode: options.executionMode,
      runMode: options.runMode,
      queueRuns: options.queueRuns,
      maxQueuedRuns: options.maxQueuedRuns,
      maxConcurrency: options.maxConcurrency,
      timeout: options.timeout,
      closeTimeout: options.closeTimeout,
      killTimeout: options.killTimeout,
      waitToExit: options.waitToExit,
      lockTtl: options.lockTtl,
      heartbeatInterval: options.heartbeatInterval,
      onLockLost: options.onLockLost,
      keepHistory: options.keepHistory,
      maxResultBytes: options.maxResultBytes,
      autostart: options.autostart,
      startPaused: options.startPaused,
      syncInterval: options.syncInterval,
      forwardLogs: options.forwardLogs,
      captureLogs: options.captureLogs.enabled,
      publish: options.publish,
      control: options.control,
      schedule: options.schedule,
      spawn: options.spawn,
    },
    {
      executionMode: "spawn",
      runMode: "single",
      queueRuns: false,
      maxQueuedRuns: 100,
      maxConcurrency: Number.POSITIVE_INFINITY,
      timeout: 0,
      closeTimeout: 5000,
      killTimeout: 2000,
      waitToExit: true,
      lockTtl: 30_000,
      heartbeatInterval: 10_000,
      onLockLost: "abort",
      keepHistory: 50,
      maxResultBytes: 16_384,
      autostart: false,
      startPaused: false,
      syncInterval: 30_000,
      forwardLogs: false,
      // Run-log capture is on by default, and it reads a spawned run's
      // output from its pipes — so the child's stdio defaults to "pipe"
      // while it is. Each piped chunk is still written straight through to
      // this process's stdout and stderr, so the terminal sees what it did.
      captureLogs: true,
      publish: false,
      // `"auto"`: on for a driver that pushes or delivers events locally
      // (this one, the default in-memory driver), off for one that polls.
      control: true,
      schedule: null,
      spawn: { stdout: "pipe", stderr: "pipe", startTimeout: 10_000 },
    },
  );
  checkEqual(
    "captureLogs: false puts the child's stdio back to inherit",
    new BunRunner({
      id: "no-capture",
      namespace,
      file: handler("runner-work"),
      captureLogs: false,
    }).options.spawn,
    { stdout: "inherit", stderr: "inherit", startTimeout: 10_000 },
  );
  checkEqual(
    "…and an explicit spawn stream wins over either default",
    new BunRunner({
      id: "explicit-stdio",
      namespace,
      file: handler("runner-work"),
      spawn: { stderr: "ignore" },
    }).options.spawn,
    { stdout: "pipe", stderr: "ignore", startTimeout: 10_000 },
  );

  const named = new BunRunner({
    id: "named",
    name: "Nightly cleanup",
    namespace,
    file: handler("runner-work"),
    lockTtl: 6000,
  });
  checkEqual("name option", named.name, "Nightly cleanup");
  checkEqual(
    "heartbeatInterval defaults to a third of lockTtl",
    named.options.heartbeatInterval,
    2000,
  );

  await checkRejects(
    "maxConcurrency below 1",
    () =>
      new BunRunner({
        id: "bad",
        namespace,
        file: handler("runner-work"),
        maxConcurrency: 0,
      }),
    { name: "ConfigError", code: "CONFIG" },
  );
  await checkRejects(
    "a file that does not resolve",
    () => new BunRunner({ id: "bad", namespace, file: "./no-such-handler.ts" }),
    { name: "ConfigError", code: "CONFIG" },
  );
  await checkRejects(
    "a malformed cron expression",
    () =>
      new BunRunner({
        id: "bad",
        namespace,
        file: handler("runner-work"),
        schedule: "not a cron",
      }),
    { name: "ConfigError" },
  );
  await checkRejects(
    "a non-positive interval",
    () =>
      new BunRunner({
        id: "bad",
        namespace,
        file: handler("runner-work"),
        schedule: { every: 0 },
      }),
    { name: "ConfigError" },
  );
}

/* ------------------------------------------------------------------ */
step("schedule: every form it accepts");

{
  // Six-field cron: seconds. Scheduled runs get the runner's default args.
  const { runner, t } = makeRunner({
    id: "schedule-cron6",
    schedule: "*/1 * * * * *",
    args: { tag: "scheduled" },
  });
  checkEqual("six-field cron normalised", runner.schedule, {
    cron: "*/1 * * * * *",
  });
  await runner.start();
  check(
    "scheduled event carries the next fire",
    t.scheduled[0] instanceof Date,
    t.scheduled,
  );
  await waitFor("two six-field cron runs", () => t.finished.length >= 2, WAIT);
  await runner.stop();
  check(
    "cron runs are source 'schedule', with the default args",
    t.finished.every(
      (entry) =>
        entry.record.source === "schedule" && entry.result.tag === "scheduled",
    ),
    t.finished.map((entry) => entry.result),
  );
}

{
  const { runner } = makeRunner({
    id: "schedule-cron5",
    schedule: "0 3 * * *",
  });
  const next = runner.nextRunAt();
  checkEqual("five-field cron normalised", runner.schedule, {
    cron: "0 3 * * *",
  });
  check(
    "five-field cron: next fire is a future 03:00",
    next !== null &&
      next.getTime() > Date.now() &&
      next.getHours() === 3 &&
      next.getMinutes() === 0,
    next,
  );
}

{
  const tz = "America/New_York";
  const { runner } = makeRunner({
    id: "schedule-tz",
    schedule: { cron: "0 9 * * 1", tz },
  });
  const next = runner.nextRunAt();
  checkEqual("{ cron, tz } normalised", runner.schedule, {
    cron: "0 9 * * 1",
    tz,
  });
  const parts = next
    ? Object.fromEntries(
        new Intl.DateTimeFormat("en-US", {
          timeZone: tz,
          weekday: "short",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        })
          .formatToParts(next)
          .map((part) => [part.type, part.value]),
      )
    : {};
  checkEqual("{ cron, tz }: next fire is Monday 09:00 in that zone", parts, {
    weekday: "Mon",
    literal: ":",
    hour: "09",
    minute: "00",
  });
}

{
  const { runner, t } = makeRunner({ id: "schedule-interval", schedule: 200 });
  checkEqual("a number is an interval", runner.schedule, { every: 200 });
  await runner.start();
  await waitFor("two interval runs", () => t.finished.length >= 2, WAIT);
  await runner.stop();
  check(
    "interval runs are scheduled",
    t.finished.every((entry) => entry.record.source === "schedule"),
  );
}

{
  const anchor = new Date(Date.now() - 12_345);
  const { runner } = makeRunner({
    id: "schedule-anchor",
    schedule: { every: 60_000, anchor },
  });
  checkEqual("{ every, anchor } normalised to epoch ms", runner.schedule, {
    every: 60_000,
    anchor: anchor.getTime(),
  });
  const next = runner.nextRunAt();
  check(
    "{ every, anchor }: next fire stays on the anchor's grid",
    next !== null &&
      next.getTime() > Date.now() &&
      (next.getTime() - anchor.getTime()) % 60_000 === 0,
    { next, anchor },
  );
}

{
  const at = new Date(Date.now() + 400);
  const { runner, t } = makeRunner({ id: "schedule-date", schedule: at });
  checkEqual("a Date is a one-shot", runner.schedule, { at: at.getTime() });
  await runner.start();
  await waitFor("the one-shot run", () => t.finished.length === 1, WAIT);
  checkEqual("a fired one-shot has no next run", runner.nextRunAt(), null);
  await runner.stop();
  checkEqual("the one-shot fired once", t.started.length, 1);

  const { runner: atObject } = makeRunner({
    id: "schedule-at",
    schedule: { at: at.getTime() + 60_000 },
  });
  checkEqual("{ at } normalised", atObject.schedule, {
    at: at.getTime() + 60_000,
  });
}

{
  const { runner, t } = makeRunner({ id: "schedule-none" });
  checkEqual("no schedule is null", runner.schedule, null);
  checkEqual("no schedule: no next run", runner.nextRunAt(), null);
  await runner.start();
  checkEqual("no schedule: scheduled(null) on start", t.scheduled, [null]);
  await runner.stop();
}

/* ------------------------------------------------------------------ */
step("executionMode, RunContext, spawn and worker options, messages");

{
  const childConfig = config;

  for (const mode of ["in-process", "worker", "spawn"] as const) {
    const { runner, t } = makeRunner<ContextArgs, ContextReport>({
      id: `context-${mode}`,
      name: `Context (${mode})`,
      // Resolved relative to `spawn.cwd`.
      file: "./runner-context.ts",
      executionMode: mode,
      timeout: 60_000,
      // The runner shares an instance; handlers get a config.
      childDriver: childConfig,
      forwardLogs: true,
      spawn: {
        cwd: handlersDir,
        env: { EXAMPLE_OPTION_ENV: "spawn-env" },
        args: ["--example-spawn-arg"],
        stdout: "pipe",
        stderr: "pipe",
      },
      worker: {
        smol: true,
        name: "example-worker",
        env: { EXAMPLE_OPTION_ENV: "worker-env" },
        argv: ["--example-worker-arg"],
      },
    });

    const sent: boolean[] = [];
    runner.on("message", (record, data) => {
      if (typeof data === "object" && data !== null && "ready" in data) {
        sent.push(runner.send(`go-${mode}`, record.runId));
      }
    });

    await runner.start();
    const runId = startedId(
      mode,
      await runner.trigger({ args: { tag: mode, waitForMessage: true } }),
    );
    const record = await settle(t, runId);
    const report = t.finished[0]?.result;

    checkEqual(`${mode}: run succeeded`, record.status, "success");
    checkEqual(
      `${mode}: file resolved against spawn.cwd`,
      runner.file,
      join(handlersDir, "runner-context.ts"),
    );
    if (!report) {
      check(
        `${mode}: handler reported`,
        false,
        t.failed.map((entry) => entry.error),
      );
      continue;
    }

    checkEqual(
      `${mode}: ctx identity`,
      {
        runId: report.runId,
        runnerId: report.runnerId,
        runnerName: report.runnerName,
        namespace: report.namespace,
        attempt: report.attempt,
        source: report.source,
        mode: report.mode,
      },
      {
        runId,
        runnerId: `context-${mode}`,
        runnerName: `Context (${mode})`,
        namespace,
        attempt: 1,
        source: "manual",
        mode,
      },
    );
    checkEqual(
      `${mode}: ctx.startedAt is the record's`,
      report.startedAt,
      record.startedAt,
    );
    checkEqual(
      `${mode}: ctx.deadline is startedAt + timeout`,
      report.deadline,
      record.startedAt + 60_000,
    );
    checkEqual(`${mode}: ctx.args are the trigger's`, report.args, {
      tag: mode,
      waitForMessage: true,
    });
    check(
      `${mode}: ctx.signal is a live AbortSignal`,
      report.signalIsAbortSignal && !report.signalAborted,
    );
    check(`${mode}: ctx.logger is structured`, report.loggerIsStructured);
    check(
      `${mode}: progress, send, onMessage are functions`,
      report.callbacksAreFunctions,
    );
    checkEqual(
      `${mode}: ctx.driverConfig is childDriver`,
      report.driverConfig,
      childConfig,
    );
    checkEqual(
      `${mode}: ctx.driver only in-process`,
      report.hasDriver,
      mode === "in-process",
    );
    checkEqual(`${mode}: ctx.progress → progress events`, t.progress, [
      50,
      { phase: "half" },
    ]);
    checkEqual(
      `${mode}: ctx.send → message event, runner.send → ctx.onMessage`,
      report.received,
      `go-${mode}`,
    );
    checkEqual(`${mode}: runner.send to a live run answers true`, sent, [true]);
    checkEqual(
      `${mode}: runner.send to an unknown run answers false`,
      runner.send("x", "no-such-run"),
      false,
    );
    checkEqual(
      `${mode}: runner.send with nothing running answers false`,
      runner.send("x"),
      false,
    );
    checkEqual(
      `${mode}: activeRuns empty once settled`,
      runner.activeRuns.size,
      0,
    );

    if (mode === "in-process") {
      checkEqual(
        "in-process: same pid, main thread, not a child",
        [report.pid, report.isMainThread, report.isChild],
        [process.pid, true, false],
      );
      checkEqual("in-process: spawn/worker env ignored", report.env, null);
      checkEqual(
        "in-process: logs are not forwarded (no child)",
        t.logs.length,
        0,
      );
    } else if (mode === "worker") {
      checkEqual(
        "worker: same pid, off the main thread, a child",
        [report.pid, report.isMainThread, report.isChild],
        [process.pid, false, true],
      );
      checkEqual("worker.env reached the Worker", report.env, "worker-env");
      check(
        "worker.argv reached the Worker",
        report.argv.includes("--example-worker-arg"),
        report.argv,
      );
      checkEqual(
        "worker.smol and worker.name passed through",
        runner.options.worker,
        {
          smol: true,
          name: "example-worker",
          env: { EXAMPLE_OPTION_ENV: "worker-env" },
          argv: ["--example-worker-arg"],
        },
      );
      check(
        "forwardLogs: a Worker's ctx.logger → log event",
        t.logs.some((log) => log.message === "context handler running"),
        t.logs,
      );
    } else {
      check(
        "spawn: its own process",
        report.pid !== process.pid && report.isChild,
        report.pid,
      );
      checkEqual("spawn: record.pid is the child's", record.pid, report.pid);
      checkEqual("spawn.cwd is the child's cwd", report.cwd, handlersDir);
      checkEqual("spawn.env reached the child", report.env, "spawn-env");
      check(
        "spawn.args appended to the child's argv",
        report.argv.includes("--example-spawn-arg"),
        report.argv,
      );
      check(
        "spawn.stdout 'pipe' → output event",
        t.output.stdout.includes("stdout-marker"),
        t.output,
      );
      check(
        "spawn.stderr 'pipe' → output event",
        t.output.stderr.includes("stderr-marker"),
        t.output,
      );
      const log = t.logs.find(
        (entry) => entry.message === "context handler running",
      );
      check(
        "forwardLogs: the child's ctx.logger → log event, with its fields",
        log?.level === "info" &&
          (log.fields as { marker?: string }).marker === "log-marker",
        t.logs,
      );
      check(
        "forwardLogs: the forwarded line is not on stdout",
        !t.output.stdout.includes("context handler running"),
      );
    }

    await runner.stop();
  }

  // forwardLogs off: the child's logger writes to its own stdout instead.
  const { runner, t } = makeRunner<ContextArgs, ContextReport>({
    id: "context-spawn-unforwarded",
    file: handler("runner-context"),
    executionMode: "spawn",
    spawn: { stdout: "pipe", stderr: "ignore" },
  });
  await runner.start();
  await settle(t, startedId("unforwarded", await runner.trigger()));
  checkEqual("forwardLogs off: no log events", t.logs.length, 0);
  check(
    "forwardLogs off: the log line is on the child's stdout",
    t.output.stdout.includes("context handler running"),
    t.output.stdout,
  );
  checkEqual("stderr 'ignore': no stderr output events", t.output.stderr, "");
  await runner.stop();
}

/* ------------------------------------------------------------------ */
step("spawn.execPath and spawn.startTimeout: a child that never says ready");

{
  // A real executable that starts and stays silent; the entry path it is
  // handed as $1 is ignored.
  const neverReady = join(tempDir("never-ready"), "never-ready.sh");
  await Bun.write(neverReady, "#!/bin/sh\nexec sleep 30\n");
  chmodSync(neverReady, 0o755);

  const { runner, t } = makeRunner({
    id: "start-timeout",
    executionMode: "spawn",
    spawn: { execPath: neverReady, startTimeout: 300 },
  });
  await runner.start();
  const record = await settle(
    t,
    startedId("never ready", await runner.trigger()),
  );

  checkEqual("startTimeout: the run failed", record.status, "failed");
  checkEqual(
    "startTimeout: as ChildExitError",
    record.error?.name,
    "ChildExitError",
  );
  checkEqual(
    "startTimeout: the silent child was SIGKILLed",
    record.signal,
    "SIGKILL",
  );
  check(
    "startTimeout: not before the budget",
    (record.durationMs ?? 0) >= 250,
    record.durationMs,
  );
  await runner.stop();
}

/* ------------------------------------------------------------------ */
step("inProcess.reloadOnEachRun");

{
  const ids: Record<string, string[]> = {};

  for (const reloadOnEachRun of [false, true]) {
    const { runner, t } = makeRunner<unknown, string>({
      id: `reload-${reloadOnEachRun}`,
      file: handler("runner-reload"),
      inProcess: { reloadOnEachRun },
    });
    await runner.start();
    await settle(t, startedId("reload 1", await runner.trigger()));
    await settle(t, startedId("reload 2", await runner.trigger()));
    ids[String(reloadOnEachRun)] = t.finished.map((entry) => entry.result);
    await runner.stop();
  }

  const [kept1, kept2] = ids.false ?? [];
  const [fresh1, fresh2] = ids.true ?? [];
  check(
    "reloadOnEachRun false: one module instance",
    kept1 !== undefined && kept1 === kept2,
    ids,
  );
  check(
    "reloadOnEachRun true: re-imported per run",
    fresh1 !== undefined && fresh1 !== fresh2,
    ids,
  );
}

/* ------------------------------------------------------------------ */
step("runMode single: busy, lock-held, queueRuns, maxQueuedRuns, info()");

{
  // Two instances of one id: two hosts.
  const { runner: hostA, t: a } = makeRunner({ id: "single-busy" });
  const { runner: hostB } = makeRunner({ id: "single-busy" });
  await Promise.all([hostA.start(), hostB.start()]);

  const runId = startedId(
    "host A",
    await hostA.trigger({ args: { ms: 30_000 } }),
  );
  checkEqual(
    "queueRuns off, run in flight here: skipped busy",
    await hostA.trigger(),
    { outcome: "skipped", reason: "busy" },
  );
  checkEqual(
    "queueRuns off, lock held elsewhere: skipped lock-held",
    await hostB.trigger(),
    { outcome: "skipped", reason: "lock-held" },
  );
  await hostA.kill(runId);
  await settle(a, runId);
  await Promise.all([hostA.stop(), hostB.stop()]);
}

{
  const { runner, t } = makeRunner({
    id: "single-queue",
    queueRuns: true,
    maxQueuedRuns: 1,
    args: { ms: 1500, tag: "default" },
  });
  await runner.start();

  const firstId = startedId("first trigger", await runner.trigger());
  checkEqual(
    "queueRuns: a trigger while busy is queued",
    await runner.trigger({ args: { tag: "second" } }),
    {
      outcome: "queued",
      position: 1,
    },
  );
  checkEqual(
    "maxQueuedRuns: a trigger beyond the cap is skipped",
    await runner.trigger(),
    {
      outcome: "skipped",
      reason: "queue-full",
    },
  );

  const info = await runner.info();
  checkEqual(
    "info identity",
    [info.id, info.name, info.namespace, info.file],
    ["single-queue", "single-queue", namespace, runner.file],
  );
  checkEqual(
    "info settings",
    [
      info.schedule,
      info.nextRunAt,
      info.executionMode,
      info.runMode,
      info.queueRuns,
      info.maxConcurrency,
    ],
    [null, null, "in-process", "single", true, Number.POSITIVE_INFINITY],
  );
  checkEqual(
    "info state",
    [info.status, info.isPaused, info.isRunning],
    ["running", false, true],
  );
  checkEqual(
    "info.activeRuns",
    info.activeRuns.map((run) => run.runId),
    [firstId],
  );
  checkEqual("info.queuedTriggers", info.queuedTriggers, 1);
  checkEqual(
    "info.runningOn host and pid",
    [info.runningOn?.host, info.runningOn?.pid],
    [hostname(), process.pid],
  );
  check(
    "info.runningOn.since is in the past",
    (info.runningOn?.since ?? Infinity) <= Date.now(),
    info.runningOn,
  );
  checkEqual(
    "info.runningOn.runId is the run in flight",
    info.runningOn?.runId,
    firstId,
  );
  checkEqual("info.lastRun is the run in flight", info.lastRun?.runId, firstId);

  await waitFor(
    "the queued trigger to run",
    () => t.finished.length === 2,
    WAIT,
  );
  checkEqual(
    "the queued run is source 'queued' with its own args",
    t.finished.map((entry) => [entry.record.source, entry.result.tag]),
    [
      ["manual", "default"],
      ["queued", "second"],
    ],
  );
  checkEqual(
    "queued and dequeued events",
    [t.queued, t.dequeued],
    [[{ tag: "second" }], [{ tag: "second" }]],
  );
  checkEqual("skipped events", t.skipped, ["queue-full"]);

  await waitFor(
    "the lock to be released",
    async () => !(await runner.info()).isRunning,
    WAIT,
  );
  checkEqual("stats()", await runner.stats(), {
    success: 2,
    failed: 0,
    timeout: 0,
    killed: 0,
    skipped: 1,
    queued: 1,
    total: 2,
  });
  checkEqual(
    "history(limit) is newest first",
    (await runner.history(5)).map((run) => run.source),
    ["queued", "manual"],
  );
  checkEqual("history(1)", (await runner.history(1)).length, 1);

  const failedId = startedId(
    "failing run",
    await runner.trigger({ args: { fail: "deliberate failure" } }),
  );
  await settle(t, failedId);
  const afterFailure = await runner.info();
  checkEqual("info.lastError", afterFailure.lastError, {
    name: "Error",
    message: "deliberate failure",
  });
  checkEqual(
    "info.lastRun after a failure",
    [afterFailure.lastRun?.runId, afterFailure.lastRun?.status],
    [failedId, "failed"],
  );
  checkEqual("info.stats counts the failure", afterFailure.stats.failed, 1);

  await runner.resetStats();
  checkEqual("resetStats()", await runner.stats(), {
    success: 0,
    failed: 0,
    timeout: 0,
    killed: 0,
    skipped: 0,
    queued: 0,
    total: 0,
  });
  await runner.stop();
}

/* ------------------------------------------------------------------ */
step("runMode parallel: maxConcurrency, local queue, no lock, kill()");

{
  const { runner, t } = makeRunner({
    id: "parallel",
    runMode: "parallel",
    maxConcurrency: 2,
    queueRuns: true,
    maxQueuedRuns: 1,
    args: { ms: 800 },
  });
  await runner.start();

  const outcomes = [
    await runner.trigger(),
    await runner.trigger(),
    await runner.trigger(),
    await runner.trigger(),
  ];
  checkEqual(
    "parallel: two start, one queues, the fourth is queue-full",
    outcomes.map((outcome) => {
      return outcome.outcome === "skipped"
        ? `skipped:${outcome.reason}`
        : outcome.outcome === "queued"
          ? `queued:${outcome.position}`
          : "started";
    }),
    ["started", "started", "queued:1", "skipped:queue-full"],
  );

  const info = await runner.info();
  checkEqual(
    "parallel: runs overlap without a lock",
    [info.activeRuns.length, info.isRunning, info.runningOn],
    [2, false, undefined],
  );

  await waitFor("the three runs", () => t.finished.length === 3, WAIT);
  checkEqual(
    "parallel: the queued one ran as 'queued'",
    t.finished.filter((entry) => entry.record.source === "queued").length,
    1,
  );

  // kill() with no id reaches every local run.
  const long = [
    await runner.trigger({ args: { ms: 30_000 } }),
    await runner.trigger({ args: { ms: 30_000 } }),
  ];
  check(
    "two long runs started",
    long.every((outcome) => outcome.outcome === "started"),
    long,
  );
  await runner.kill();
  checkEqual(
    "kill() without an id killed both, reason 'killed'",
    t.killed.map((entry) => entry.reason),
    ["killed", "killed"],
  );
  await runner.stop();

  const { runner: capped } = makeRunner({
    id: "parallel-capped",
    runMode: "parallel",
    maxConcurrency: 1,
    args: { ms: 30_000 },
  });
  await capped.start();
  startedId("capped first", await capped.trigger());
  checkEqual(
    "maxConcurrency reached, queueRuns off: skipped max-concurrency",
    await capped.trigger(),
    {
      outcome: "skipped",
      reason: "max-concurrency",
    },
  );
  await capped.stop({ force: true });
}

/* ------------------------------------------------------------------ */
step("timeout");

{
  const { runner, t } = makeRunner({
    id: "timeout",
    timeout: 300,
    args: { ms: 30_000 },
  });
  await runner.start();
  const record = await settle(t, startedId("timeout", await runner.trigger()));

  checkEqual("timeout: status", record.status, "timeout");
  checkEqual(
    "timeout: timeout event, then failed",
    [t.timeouts.length, t.failed[0]?.error.name],
    [1, "JobTimeoutError"],
  );
  check(
    "timeout: a cooperative handler is not detached",
    record.detached !== true,
    record,
  );
  const stats = await runner.stats();
  checkEqual(
    "timeout: counted as timeout and failed",
    [stats.timeout, stats.failed],
    [1, 1],
  );
  await runner.stop();
}

/* ------------------------------------------------------------------ */
step("kill(runId, { reason, force }), closeTimeout and killTimeout");

{
  const { runner, t } = makeRunner({
    id: "kill-reason",
    args: { ms: 30_000, announce: true },
  });
  await runner.start();
  const runId = startedId("kill", await runner.trigger());
  await waitFor(
    "the handler to be working",
    () => t.messages.includes("working"),
    WAIT,
  );
  await runner.kill(runId, { reason: "operator" });
  const record = await settle(t, runId);

  checkEqual("kill: status killed", record.status, "killed");
  checkEqual(
    "kill: killed event carries the reason",
    t.killed.map((entry) => entry.reason),
    ["operator"],
  );
  checkEqual(
    "kill: failed event with RunKilledError",
    t.failed[0]?.error.name,
    "RunKilledError",
  );
  check(
    "kill: the error names the reason",
    (record.error?.message ?? "").includes("operator"),
    record.error,
  );
  checkEqual("kill: counted", (await runner.stats()).killed, 1);
  await runner.stop();
}

/** Starts a spawned run, waits for its first message, kills it, and settles. */
async function escalate(
  id: string,
  file: URL,
  args: WorkArgs | BlockingArgs,
  timeouts: { closeTimeout: number; killTimeout: number },
  kill: { force?: boolean; reason?: string } = {},
): Promise<{ record: RunRecord; killedAfter: number; reasons: string[] }> {
  const { runner, t } = makeRunner<WorkArgs | BlockingArgs, unknown>({
    id,
    file,
    executionMode: "spawn",
    ...timeouts,
  });
  await runner.start();
  const runId = startedId(id, await runner.trigger({ args }));
  await waitFor(
    `${id}: the child to be running`,
    () => t.messages.length > 0,
    WAIT,
  );
  const killedAt = Date.now();
  await runner.kill(runId, kill);
  const record = await settle(t, runId);
  await runner.stop();
  return {
    record,
    killedAfter: Date.now() - killedAt,
    reasons: t.killed.map((entry) => entry.reason),
  };
}

{
  const cooperative = await escalate(
    "escalate-cooperative",
    handler("runner-work"),
    { ms: 30_000, announce: true },
    { closeTimeout: 5000, killTimeout: 5000 },
  );
  checkEqual(
    "cooperative child: killed, no signal needed",
    [cooperative.record.status, cooperative.record.signal],
    ["killed", null],
  );
  check(
    "cooperative child: ended inside closeTimeout",
    cooperative.killedAfter < 5000,
    cooperative.killedAfter,
  );
  checkEqual(
    "cooperative child: RunKilledError",
    cooperative.record.error?.name,
    "RunKilledError",
  );

  // A child exits itself 500ms before `closeTimeout` when it can; above that
  // margin, a blocked child cannot, so the signal is what ends it.
  const term = await escalate(
    "escalate-sigterm",
    handler("runner-blocking"),
    { ignoreSigterm: false, ms: 30_000 },
    { closeTimeout: 1500, killTimeout: 20_000 },
  );
  checkEqual(
    "blocked child: SIGTERM after closeTimeout",
    [term.record.status, term.record.signal],
    ["killed", "SIGTERM"],
  );
  check(
    "blocked child: before killTimeout",
    term.killedAfter < 20_000,
    term.killedAfter,
  );

  const kill = await escalate(
    "escalate-sigkill",
    handler("runner-blocking"),
    { ignoreSigterm: true, ms: 30_000 },
    { closeTimeout: 1500, killTimeout: 500 },
  );
  checkEqual(
    "child ignoring SIGTERM: SIGKILL after killTimeout",
    [kill.record.status, kill.record.signal],
    ["killed", "SIGKILL"],
  );

  const forced = await escalate(
    "kill-force",
    handler("runner-blocking"),
    { ignoreSigterm: true, ms: 30_000 },
    { closeTimeout: 20_000, killTimeout: 20_000 },
    { force: true, reason: "now" },
  );
  checkEqual(
    "force: straight to SIGKILL",
    [forced.record.signal, forced.reasons],
    ["SIGKILL", ["now"]],
  );
  check(
    "force: without waiting out closeTimeout",
    forced.killedAfter < 20_000,
    forced.killedAfter,
  );
}

/* ------------------------------------------------------------------ */
step("stop({ timeout }), stop({ force }), and a stopped runner");

{
  const { runner, t } = makeRunner({
    id: "stop-timeout",
    closeTimeout: 60_000,
    args: { ms: 30_000, announce: true },
  });
  await runner.start();
  const runId = startedId("stop-timeout", await runner.trigger());
  await waitFor(
    "the handler to be working",
    () => t.messages.includes("working"),
    WAIT,
  );
  const stoppingAt = Date.now();
  await runner.stop({ timeout: 100 });

  checkEqual(
    "stop({ timeout }): the run is killed with reason 'stop'",
    t.killed.map((entry) => [entry.record.runId, entry.reason]),
    [[runId, "stop"]],
  );
  check(
    "stop({ timeout }) overrides closeTimeout",
    Date.now() - stoppingAt < 60_000,
    Date.now() - stoppingAt,
  );
  checkEqual(
    "stop: status and stopped event",
    [runner.status, t.stopped],
    ["stopped", 1],
  );
  await checkRejects("a manual trigger after stop", () => runner.trigger(), {
    name: "RunnerStoppedError",
    code: "RUNNER_STOPPED",
  });
  checkEqual(
    "a non-manual trigger after stop is skipped",
    await runner.trigger({ source: "schedule" }),
    {
      outcome: "skipped",
      reason: "stopped",
    },
  );
}

{
  const { runner, t } = makeRunner<BlockingArgs, string>({
    id: "stop-force",
    file: handler("runner-blocking"),
    executionMode: "spawn",
    closeTimeout: 20_000,
    killTimeout: 20_000,
  });
  await runner.start();
  const runId = startedId(
    "stop-force",
    await runner.trigger({ args: { ignoreSigterm: true, ms: 30_000 } }),
  );
  await waitFor(
    "the child to be blocking",
    () => t.messages.includes("blocking"),
    WAIT,
  );
  const stoppingAt = Date.now();
  await runner.stop({ force: true });
  const record = await settle(t, runId);
  checkEqual(
    "stop({ force }): SIGKILL, reason stop",
    [record.signal, t.killed[0]?.reason],
    ["SIGKILL", "stop"],
  );
  check(
    "stop({ force }): without the grace periods",
    Date.now() - stoppingAt < 20_000,
    Date.now() - stoppingAt,
  );
}

/* ------------------------------------------------------------------ */
step("lockTtl, heartbeatInterval, onLockLost");

for (const onLockLost of ["abort", "continue"] as const) {
  // A lock shorter than the gap between heartbeats lapses mid-run; a second
  // host takes it; the holder learns at its next heartbeat.
  const { runner: holder, t: h } = makeRunner({
    id: `lock-lost-${onLockLost}`,
    lockTtl: 600,
    heartbeatInterval: 2500,
    onLockLost,
  });
  const { runner: other, t: o } = makeRunner({ id: `lock-lost-${onLockLost}` });
  checkEqual(
    `${onLockLost}: options`,
    [
      holder.options.lockTtl,
      holder.options.heartbeatInterval,
      holder.options.onLockLost,
    ],
    [600, 2500, onLockLost],
  );
  await Promise.all([holder.start(), other.start()]);

  const runId = startedId(
    `${onLockLost} holder`,
    await holder.trigger({
      args: { ms: onLockLost === "abort" ? 30_000 : 4000 },
    }),
  );
  await waitFor(
    `${onLockLost}: the lock to lapse`,
    async () => !(await other.info()).isRunning,
    WAIT,
  );
  const otherId = startedId(
    `${onLockLost}: another host takes the lapsed lock`,
    await other.trigger({ args: { ms: 200 } }),
  );

  const record = await settle(h, runId);
  check(
    `${onLockLost}: lockLost emitted for the run`,
    h.lockLost.some((run) => run.runId === runId),
    h.lockLost,
  );
  if (onLockLost === "abort") {
    checkEqual(
      "abort: the run is killed with reason 'lock-lost'",
      [record.status, h.killed[0]?.reason],
      ["killed", "lock-lost"],
    );
  } else {
    checkEqual(
      "continue: the run carries on and succeeds",
      record.status,
      "success",
    );
  }
  await settle(o, otherId);
  await Promise.all([holder.stop(), other.stop()]);
}

/* ------------------------------------------------------------------ */
step("keepHistory and maxResultBytes");

{
  const { runner, t } = makeRunner({ id: "keep-history", keepHistory: 3 });
  await runner.start();
  for (let index = 1; index <= 5; index++) {
    await settle(
      t,
      startedId(
        `history run ${index}`,
        await runner.trigger({ args: { tag: `t${index}` } }),
      ),
    );
  }
  const history = await runner.history(10);
  checkEqual(
    "keepHistory: only the newest 3 kept",
    history.map((run) => (run.result as WorkResult).tag),
    ["t5", "t4", "t3"],
  );
  await runner.stop();
}

{
  const { runner, t } = makeRunner<BigResultArgs, BigResult>({
    id: "max-result",
    file: handler("runner-big-result"),
    maxResultBytes: 200,
  });
  await runner.start();

  await settle(
    t,
    startedId("big result", await runner.trigger({ args: { bytes: 1000 } })),
  );
  const stored = (await runner.history(1))[0]?.result as {
    __truncated?: boolean;
    bytes?: number;
    preview?: string;
  };
  checkEqual(
    "maxResultBytes: the finished event carries the whole result",
    t.finished[0]?.result.payload.length,
    1000,
  );
  check(
    "maxResultBytes: history stores a truncation marker instead",
    stored?.__truncated === true &&
      (stored.bytes ?? 0) > 200 &&
      typeof stored.preview === "string" &&
      stored.preview.length <= 200,
    stored,
  );

  await settle(
    t,
    startedId("small result", await runner.trigger({ args: { bytes: 10 } })),
  );
  checkEqual(
    "maxResultBytes: a result within the cap is stored as is",
    (await runner.history(1))[0]?.result,
    { payload: "x".repeat(10) },
  );
  await runner.stop();
}

/* ------------------------------------------------------------------ */
step("driver: config vs instance, childDriver");

{
  /** Counts close() calls on a driver without changing what close does. */
  function countCloses(driver: { close: () => Promise<void> }): () => number {
    let calls = 0;
    const original = driver.close.bind(driver);
    driver.close = async () => {
      calls++;
      await original();
    };
    return () => calls;
  }

  const fromConfig = new BunRunner({
    id: "owns-config",
    namespace,
    file: handler("runner-work"),
    driver: exampleDriver(),
    logger: noopLogger,
  });
  const configCloses = countCloses(fromConfig.driver);
  checkEqual(
    "a config driver becomes childDriver",
    fromConfig.options.childDriver?.type,
    config.type,
  );
  await fromConfig.start();
  await fromConfig.stop();
  checkEqual(
    "a driver built from a config is closed by stop()",
    configCloses(),
    1,
  );

  const defaulted = new BunRunner({
    id: "owns-default",
    namespace: "runner-options-default",
    file: handler("runner-work"),
    logger: noopLogger,
  });
  const defaultCloses = countCloses(defaulted.driver);
  checkEqual("no driver: a memory driver", defaulted.driver.name, "memory");
  await defaulted.start();
  await defaulted.stop();
  checkEqual(
    "the default memory driver is owned and closed",
    defaultCloses(),
    1,
  );

  // The shared instance: count closes without letting one happen.
  let sharedCloses = 0;
  const realClose = shared.close;
  shared.close = async () => {
    sharedCloses++;
  };
  const { runner: onInstance, t } = makeRunner<ContextArgs, ContextReport>({
    id: "shares-instance",
    file: handler("runner-context"),
  });
  checkEqual(
    "an instance with no childDriver: no childDriver",
    onInstance.options.childDriver,
    undefined,
  );
  await onInstance.start();
  await settle(t, startedId("instance run", await onInstance.trigger()));
  checkEqual(
    "in-process on an instance: ctx.driver but no ctx.driverConfig",
    [t.finished[0]?.result.hasDriver, t.finished[0]?.result.driverConfig],
    [true, null],
  );
  await onInstance.stop();
  shared.close = realClose;
  checkEqual(
    "a driver instance is never closed by the runner",
    sharedCloses,
    0,
  );
}

/* ------------------------------------------------------------------ */
step("logger, the logger setter, and the error event");

{
  const first = createTestLogger();
  const second = createTestLogger();
  const { runner, t } = makeRunner<ContextArgs, ContextReport>({
    id: "logger",
    name: "logged-runner",
    file: handler("runner-context"),
    logger: first.logger,
  });
  await runner.start();

  const runId = startedId("logged run", await runner.trigger());
  await settle(t, runId);
  const line = first.events.find(
    (event) => event.message === "context handler running",
  );
  checkEqual(
    "logger: ctx.logger is bound to the runner and the run",
    [
      line?.bindings.namespace,
      line?.bindings.runnerId,
      line?.bindings.runId,
      line?.fields.marker,
    ],
    [namespace, "logger", runId, "log-marker"],
  );
  checkEqual("logger: named after the runner", line?.name, "logged-runner");

  runner.logger = second.logger;
  // The getter answers with the new logger re-bound to this runner — a child
  // of it, not the same object — so check where its lines go, not identity.
  runner.logger.info("written through the getter");
  const viaGetter = second.events.find(
    (event) => event.message === "written through the getter",
  );
  checkEqual(
    "logger setter: the getter writes to the new logger, bound to the runner",
    [viaGetter?.bindings.namespace, viaGetter?.bindings.runnerId],
    [namespace, "logger"],
  );
  const secondId = startedId("second logged run", await runner.trigger());
  await settle(t, secondId);
  const moved = second.events.find(
    (event) => event.message === "context handler running",
  );
  check(
    "logger setter: later runs log to the new logger",
    moved !== undefined,
    second.events,
  );
  checkEqual(
    "logger setter: the old logger hears nothing more",
    first.events.filter((event) => event.message === "context handler running")
      .length,
    1,
  );
  checkEqual(
    "logger setter: keeps this runner's bindings",
    moved?.bindings.runnerId,
    "logger",
  );
  await runner.stop();
}

{
  const broken = createDriver({ type: "memory" });
  broken.listHistory = async () => {
    throw new Error("history unavailable");
  };
  /** Whether `events` holds the logged history failure. */
  const loggedFailure = (
    events: ReturnType<typeof createTestLogger>["events"],
  ) => {
    return events.some(
      (event) =>
        event.level === "error" &&
        event.message === "history unavailable" &&
        event.fields.context === "history",
    );
  };

  // A runner nobody listens to at all.
  const silent = createTestLogger();
  const unobserved = new BunRunner({
    id: "errors-unobserved",
    namespace,
    file: handler("runner-work"),
    driver: broken,
    logger: silent.logger,
  });
  checkEqual(
    "history() tolerates a failing driver",
    await unobserved.history(),
    [],
  );
  check(
    "no listeners at all: a failure outside a run is logged",
    loggedFailure(silent.events),
    silent.events,
  );

  // The same, on a runner that has listeners — just not for `error`.
  const { logger, events } = createTestLogger();
  const { runner } = makeRunner({ id: "errors", driver: broken, logger });
  await runner.history();
  // Listeners for other events do not count: with nothing listening for
  // `error` specifically, the failure is logged rather than lost.
  check(
    "listeners for other events only: a failure outside a run is still logged",
    loggedFailure(events),
    events,
  );

  const errors: [string, string][] = [];
  runner.on("error", (error, context) => errors.push([error.message, context]));
  await runner.history();
  checkEqual("error event: the error and its context", errors, [
    ["history unavailable", "history"],
  ]);
}

/* ------------------------------------------------------------------ */
step("args, autostart, startPaused, pause/resume, updateSchedule");

{
  const { runner, t } = makeRunner({ id: "args", args: { tag: "default" } });
  await runner.start();
  await settle(t, startedId("default args", await runner.trigger()));
  await settle(
    t,
    startedId(
      "trigger args",
      await runner.trigger({ args: { tag: "override" } }),
    ),
  );
  checkEqual(
    "args: defaults, then the trigger's",
    t.finished.map((entry) => entry.result.tag),
    ["default", "override"],
  );
  await runner.stop();
}

{
  const { runner } = makeRunner({ id: "autostart", autostart: true });
  await waitFor(
    "autostart to start the runner",
    () => runner.status === "running",
    WAIT,
  );
  checkEqual("autostart: running without start()", runner.status, "running");
  await runner.stop();
}

{
  const { runner, t } = makeRunner({
    id: "start-paused",
    startPaused: true,
    schedule: 150,
  });
  await runner.start();
  checkEqual("startPaused: status paused", runner.status, "paused");
  checkEqual(
    "startPaused: the flag is persisted",
    (await runner.info()).isPaused,
    true,
  );
  await waitFor(
    "a scheduled tick to be skipped while paused",
    () => t.skipped.includes("paused"),
    WAIT,
  );
  checkEqual("paused: a trigger is skipped", await runner.trigger(), {
    outcome: "skipped",
    reason: "paused",
  });
  const forcedId = startedId(
    "trigger({ force }) while paused",
    await runner.trigger({ force: true }),
  );
  await settle(t, forcedId);

  await runner.updateSchedule(null);
  checkEqual("updateSchedule(null)", runner.schedule, null);

  await runner.resume({ triggerNow: true });
  await waitFor("the resume run", () => t.finished.length === 2, WAIT);
  checkEqual(
    "resume({ triggerNow }): a run with source 'resume'",
    t.finished[1]?.record.source as string,
    "resume",
  );
  checkEqual(
    "resume: status, flag, event",
    [runner.status, (await runner.info()).isPaused, t.resumed],
    ["running", false, 1],
  );
  checkEqual("resume re-arms the updated schedule", runner.nextRunAt(), null);

  await runner.pause();
  checkEqual(
    "pause: status, flag, event",
    [runner.status, (await runner.info()).isPaused, t.paused],
    ["paused", true, 1],
  );
  await runner.resume();
  checkEqual("resume() without triggerNow starts nothing", t.started.length, 2);

  await runner.updateSchedule({ every: 3_600_000 });
  checkEqual(
    "updateSchedule while running re-arms the ticker",
    [runner.schedule, t.scheduled.at(-1) instanceof Date],
    [{ every: 3_600_000 }, true],
  );
  await runner.stop();
}

/* ------------------------------------------------------------------ */
step("syncInterval: another instance's pause and schedule are adopted");

{
  const { runner: synced, t: s } = makeRunner({
    id: "synced",
    syncInterval: 150,
  });
  const { runner: unsynced } = makeRunner({ id: "synced", syncInterval: 0 });
  const { runner: elsewhere } = makeRunner({ id: "synced" });
  await Promise.all([synced.start(), unsynced.start(), elsewhere.start()]);

  await elsewhere.pause();
  await waitFor(
    "the synced instance to adopt the pause",
    () => synced.status === "paused",
    WAIT,
  );
  checkEqual("syncInterval: paused event on adoption", s.paused, 1);

  await elsewhere.updateSchedule({ every: 3_600_000 });
  await waitFor(
    "the synced instance to adopt the schedule",
    () => synced.schedule !== null,
    WAIT,
  );
  checkEqual("syncInterval: the schedule is adopted", synced.schedule, {
    every: 3_600_000,
  });
  checkEqual(
    "syncInterval 0: neither is adopted",
    [unsynced.status, unsynced.schedule],
    ["running", null],
  );

  await elsewhere.resume();
  await waitFor(
    "the synced instance to adopt the resume",
    () => synced.status === "running",
    WAIT,
  );
  checkEqual("syncInterval: resumed event on adoption", s.resumed, 1);
  await Promise.all([synced.stop(), unsynced.stop(), elsewhere.stop()]);
}

/* ------------------------------------------------------------------ */
step("waitToExit: a process whose only work is a runner");

{
  /** A child process running only a scheduled runner, and what it printed. */
  function spawnRunnerOnly(waitToExit: boolean) {
    const child = Bun.spawn(
      [process.execPath, join(handlersDir, "runner-wait-to-exit.ts")],
      {
        env: { ...process.env, WAIT_TO_EXIT: waitToExit ? "1" : "0" },
        stdout: "pipe",
        stderr: "inherit",
      },
    );
    const printed = { text: "" };
    void (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of child.stdout) {
        printed.text += decoder.decode(chunk, { stream: true });
      }
    })();
    return { child, printed };
  }

  const kept = spawnRunnerOnly(true);
  const released = spawnRunnerOnly(false);
  await waitFor(
    "both runners to start",
    () =>
      kept.printed.text.includes("runner-started") &&
      released.printed.text.includes("runner-started"),
    WAIT,
  );

  await waitFor(
    "waitToExit false: the process to exit",
    () => released.child.exitCode !== null,
    WAIT,
  );
  checkEqual(
    "waitToExit false: exits cleanly with nothing else to do",
    released.child.exitCode,
    0,
  );
  // The same chance to exit, and then some: it must still be there.
  await Bun.sleep(1500);
  checkEqual(
    "waitToExit true: the schedule keeps the process alive",
    kept.child.exitCode,
    null,
  );
  kept.child.kill();
  await kept.child.exited;
}

/* ------------------------------------------------------------------ */
step("publish: events for listeners in other processes");

{
  const notifier = new JobsNotifier(shared, namespace, {
    queues: [],
    runners: ["publish-on", "publish-off"],
  });
  await notifier.start();
  const heard: { target: string; type: string }[] = [];
  notifier.on("event", (event) => {
    if (event.kind === "runner") {
      heard.push({ target: event.target, type: event.type });
    }
  });

  const { runner: quiet, t: q } = makeRunner({ id: "publish-off" });
  const { runner: loud, t: l } = makeRunner({
    id: "publish-on",
    publish: true,
  });
  await Promise.all([quiet.start(), loud.start()]);

  await settle(q, startedId("unpublished run", await quiet.trigger()));
  await settle(l, startedId("published run", await loud.trigger()));
  await settle(
    l,
    startedId(
      "published failure",
      await loud.trigger({ args: { fail: "published failure" } }),
    ),
  );
  await loud.pause();
  await loud.trigger();

  const types = () =>
    heard
      .filter((event) => event.target === "publish-on")
      .map((event) => event.type);
  await waitFor(
    "the published events",
    () =>
      ["started", "succeeded", "failed", "skipped"].every((type) =>
        types().includes(type),
      ),
    WAIT,
  );
  checkEqual(
    "publish: started, succeeded, failed, skipped heard",
    ["started", "succeeded", "failed", "skipped"].filter((type) =>
      types().includes(type),
    ).length,
    4,
  );
  checkEqual(
    "publish off (the default): nothing heard",
    heard.filter((event) => event.target === "publish-off").length,
    0,
  );

  await notifier.close();
  await Promise.all([quiet.stop(), loud.stop()]);
}

/* ------------------------------------------------------------------ */
step("BunRunnerManager");

{
  const { logger, events } = createTestLogger();
  const manager = new BunRunnerManager({ namespace, driver: shared, logger });

  const fromOptions = manager.add<WorkArgs, WorkResult>({
    id: "managed-a",
    file: handler("runner-work"),
    executionMode: "in-process",
  });
  created.push(fromOptions);
  checkEqual(
    "add(options): the manager's namespace and driver",
    [fromOptions.namespace, fromOptions.driver === shared],
    [namespace, true],
  );
  fromOptions.logger.info("from a managed runner");
  check(
    "add(options): the manager's logger",
    events.some(
      (event) =>
        event.message === "from a managed runner" &&
        event.bindings.runnerId === "managed-a",
    ),
    events,
  );

  const instance = new BunRunner({
    id: "managed-b",
    namespace,
    file: handler("runner-work"),
    executionMode: "in-process",
    driver: shared,
    logger: noopLogger,
  });
  created.push(instance);
  check("add(instance) returns it", manager.add(instance) === instance);

  await checkRejects(
    "add: a runner from another namespace",
    () =>
      manager.add(
        new BunRunner({
          id: "managed-c",
          namespace: `${namespace}-other`,
          file: handler("runner-work"),
          driver: shared,
          logger: noopLogger,
        }),
      ),
    { name: "ConfigError", code: "CONFIG" },
  );
  await checkRejects(
    "add: a duplicate id",
    () => manager.add({ id: "managed-a", file: handler("runner-work") }),
    {
      name: "ConfigError",
      code: "CONFIG",
    },
  );

  checkEqual(
    "get / size / list",
    [
      manager.get("managed-a") === fromOptions,
      manager.get("nope"),
      manager.size,
      manager.list().map((runner) => runner.id),
    ],
    [true, undefined, 2, ["managed-a", "managed-b"]],
  );

  await manager.startAll();
  checkEqual(
    "startAll",
    manager.list().map((runner) => runner.status),
    ["running", "running"],
  );
  checkEqual(
    "info()",
    (await manager.info()).map((info) => [info.id, info.status]),
    [
      ["managed-a", "running"],
      ["managed-b", "running"],
    ],
  );
  // These two have started but never run; the backend knows them anyway.
  const discovered = await manager.discover();
  check(
    "discover() with a driver asks the backend",
    ["managed-a", "managed-b", "single-queue"].every((id) =>
      discovered.includes(id),
    ),
    discovered,
  );

  const driverless = new BunRunnerManager({ namespace });
  driverless.add(instance);
  checkEqual(
    "discover() without a driver lists what is registered",
    await driverless.discover(),
    ["managed-b"],
  );

  checkEqual(
    "remove(id, { stop: false }) leaves it running",
    [
      await manager.remove("managed-b", { stop: false }),
      instance.status,
      manager.size,
    ],
    [true, "running", 1],
  );
  await instance.stop();
  checkEqual(
    "remove(id) stops it",
    [await manager.remove("managed-a"), fromOptions.status, manager.size],
    [true, "stopped", 0],
  );
  checkEqual("remove(unknown)", await manager.remove("nope"), false);

  const extra = [
    manager.add({
      id: "managed-d",
      file: handler("runner-work"),
      executionMode: "in-process",
    }),
    manager.add({
      id: "managed-e",
      file: handler("runner-work"),
      executionMode: "in-process",
    }),
  ];
  created.push(...extra);
  await manager.startAll();
  await manager.stopAll({ timeout: 1000 });
  checkEqual(
    "stopAll",
    extra.map((runner) => runner.status),
    ["stopped", "stopped"],
  );
}

/* ------------------------------------------------------------------ */
step("BunRunnerManager.controller(): a runner another instance owns");

{
  const { runner: owned, t } = makeRunner({
    id: "remote-owned",
    schedule: 3_600_000,
    maxQueuedRuns: 2,
    // Hear control events now; the sync timer is off, so nothing else could.
    control: true,
    syncInterval: 0,
  });
  const ownerManager = new BunRunnerManager({ namespace, driver: shared });
  ownerManager.add(owned);
  await owned.start();

  // Registers nothing: as far as it can tell, the runner lives elsewhere.
  const admin = new BunRunnerManager({ namespace, driver: shared });
  const local = await ownerManager.controller<WorkArgs, WorkResult>(
    "remote-owned",
  );
  const remote = await admin.controller<WorkArgs, WorkResult>("remote-owned");
  checkEqual(
    "controller(id): isLocal where it is registered, not elsewhere",
    [local.isLocal, remote.isLocal],
    [true, false],
  );

  const info = await remote.info();
  checkEqual(
    "info(): the owner's persisted configuration and state",
    [
      info.name,
      info.executionMode,
      info.runMode,
      info.queueRuns,
      info.maxQueuedRuns,
      info.schedule,
      info.isPaused,
      info.isRunning,
      info.local,
    ],
    [
      "remote-owned",
      "in-process",
      "single",
      false,
      2,
      { every: 3_600_000 },
      false,
      false,
      undefined,
    ],
  );
  checkEqual(
    "info().local: only on a local controller",
    (await local.info()).local?.status,
    "running",
  );

  await remote.pause();
  await waitFor(
    "the owner to adopt a remote pause",
    () => owned.status === "paused",
    WAIT,
  );
  checkEqual("pause(): the owner emits paused", t.paused, 1);
  checkEqual("trigger() while paused", await remote.trigger(), {
    outcome: "skipped",
    reason: "paused",
  });

  await remote.updateSchedule({ every: 7_200_000 });
  await waitFor(
    "the owner to adopt a remote schedule",
    () => JSON.stringify(owned.schedule) === '{"every":7200000}',
    WAIT,
  );
  checkEqual("updateSchedule(): the owner re-armed", owned.schedule, {
    every: 7_200_000,
  });

  await remote.resume();
  await waitFor(
    "the owner to adopt a remote resume",
    () => owned.status === "running",
    WAIT,
  );
  checkEqual("resume(): the owner emits resumed", t.resumed, 1);

  checkEqual(
    "trigger(): queued, whatever queueRuns says",
    await remote.trigger(),
    { outcome: "queued", position: 1 },
  );
  await waitFor("the owner to run it", () => t.finished.length === 1, WAIT);
  checkEqual(
    "trigger(): the owner ran it, with source 'queued'",
    t.finished[0]?.record.source,
    "queued",
  );

  await waitFor(
    "the run to be recorded",
    async () => (await remote.stats()).success === 1,
    WAIT,
  );
  checkEqual(
    "history() and stats() read the shared record",
    [
      (await remote.history(1))[0]?.runId,
      await remote.stats(),
      await local.stats(),
    ],
    [
      t.finished[0]?.record.runId,
      {
        success: 1,
        failed: 0,
        timeout: 0,
        killed: 0,
        skipped: 1,
        queued: 1,
        total: 1,
      },
      {
        success: 1,
        failed: 0,
        timeout: 0,
        killed: 0,
        skipped: 1,
        queued: 1,
        total: 1,
      },
    ],
  );

  checkEqual("no remote kill", "kill" in remote, false);
  await checkRejects(
    "controller(): an id nobody registered",
    () => admin.controller("remote-nobody"),
    { name: "RunnerNotFoundError", code: "RUNNER_NOT_FOUND" },
  );
  await checkRejects(
    "controller(): without a driver, only registered runners",
    () => new BunRunnerManager({ namespace }).controller("remote-owned"),
    { name: "RunnerNotFoundError", code: "RUNNER_NOT_FOUND" },
  );
  await checkRejects(
    "controller(): an unusable id",
    () => admin.controller("not a runner id"),
    { name: "ConfigError", code: "CONFIG" },
  );
  await checkRejects(
    "updateSchedule(): a malformed schedule, before anything is written",
    () => remote.updateSchedule("every blue moon"),
    { name: "ConfigError", code: "CONFIG" },
  );

  await owned.stop();
}

/* ------------------------------------------------------------------ */
step("Clean up");

await Promise.all(
  created
    .filter((runner) => runner.status !== "stopped")
    .map(async (runner) => {
      await runner.stop({ force: true });
    }),
);
await shared.purge(namespace);
await shared.close();
show("namespace purged", namespace);

summary();
