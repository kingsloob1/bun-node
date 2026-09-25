import type { BunRunnerOptions, RunRecord } from "../lib/index";
import { join } from "node:path";
import process from "node:process";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import {
  BunRunner,
  BunRunnerManager,
  ConfigError,
  JobsError,
  MemoryDriver,
  RunnerController,
  RunnerNotFoundError,
} from "../lib/index";
import { testNamespace, waitFor } from "./helpers";

/**
 * `BunRunnerManager.controller()` in one process, on the memory driver.
 *
 * Two managers sharing a driver stand in for two processes: one registers and
 * owns the runner, the other only knows its id. What the second sees and does
 * must go through the backend alone — the cross-process suite proves the same
 * with genuinely separate processes.
 */

/** Handler fixtures, resolved from this file. */
const fixture = (name: string) =>
  join(import.meta.dir, "fixtures", "handlers", `${name}.ts`);

/** What the `append` fixture accepts. */
interface AppendArgs {
  /** Recorded as the result's prefix. */
  marker?: string;
  /** How long the run lasts, in milliseconds. */
  ms?: number;
}

/** Runners started by a test, stopped afterwards so nothing outlives it. */
const started: BunRunner<AppendArgs, string>[] = [];

afterEach(async () => {
  await Promise.allSettled(
    started.map((runner) => runner.stop({ force: true })),
  );
  started.length = 0;
});

/** One namespace and driver, an owning manager and an observing one. */
function cluster(): {
  driver: MemoryDriver;
  namespace: string;
  owner: BunRunnerManager;
  observer: BunRunnerManager;
} {
  const driver = new MemoryDriver();
  const namespace = testNamespace("remote");
  return {
    driver,
    namespace,
    owner: new BunRunnerManager({ namespace, driver, logger: noopLogger }),
    observer: new BunRunnerManager({ namespace, driver, logger: noopLogger }),
  };
}

/** Registers the `append` runner with `manager`, with quiet test defaults. */
function addRunner(
  manager: BunRunnerManager,
  options: Partial<Omit<BunRunnerOptions<AppendArgs>, "namespace">> = {},
): BunRunner<AppendArgs, string> {
  const runner = manager.add<AppendArgs, string>({
    id: "reports",
    file: fixture("append"),
    executionMode: "in-process",
    waitToExit: false,
    syncInterval: 0,
    args: { marker: "default", ms: 5 },
    ...options,
  });
  started.push(runner);
  return runner;
}

/** Collects every `finished` run, with its result. */
function finishedRuns(
  runner: BunRunner<AppendArgs, string>,
): { record: RunRecord; result: string }[] {
  const runs: { record: RunRecord; result: string }[] = [];
  runner.on("finished", (record, result) => runs.push({ record, result }));
  return runs;
}

describe("BunRunnerManager.controller(): local and remote agree", () => {
  it("reads the same state, history and stats either way", async () => {
    const { owner, observer } = cluster();
    const runner = addRunner(owner, { schedule: { cron: "0 3 * * *" } });
    const runs = finishedRuns(runner);
    await runner.start();
    await runner.trigger();
    await waitFor(() => runs.length === 1);

    const local = await owner.controller<AppendArgs, string>("reports");
    const remote = await observer.controller<AppendArgs, string>("reports");
    expect([local.isLocal, remote.isLocal]).toEqual([true, false]);

    const { local: localView, isLocal: _l, ...localInfo } = await local.info();
    const {
      local: remoteView,
      isLocal: _r,
      ...remoteInfo
    } = await remote.info();

    expect(remoteInfo).toEqual(localInfo);
    expect(remoteView).toBeUndefined();
    expect(localView?.status).toBe("running");
    expect(remoteInfo).toMatchObject({
      id: "reports",
      name: "reports",
      file: fixture("append"),
      schedule: { cron: "0 3 * * *" },
      executionMode: "in-process",
      runMode: "single",
      queueRuns: false,
      maxQueuedRuns: 100,
      maxConcurrency: Number.POSITIVE_INFINITY,
      isPaused: false,
      isRunning: false,
      queuedTriggers: 0,
      stats: { success: 1, total: 1 },
    });
    expect(remoteInfo.lastRun?.result).toBe(runs[0]?.result);

    // And both agree with the runner's own view of the cluster.
    const own = await runner.info();
    expect(remoteInfo).toMatchObject({
      isPaused: own.isPaused,
      isRunning: own.isRunning,
      queuedTriggers: own.queuedTriggers,
      stats: own.stats,
      lastRun: own.lastRun,
      nextRunAt: own.nextRunAt,
    });

    expect(await remote.history()).toEqual(await local.history());
    expect(await remote.stats()).toEqual(await local.stats());
  });

  it("delegates to a local runner, which may start a run at once", async () => {
    const { owner } = cluster();
    const runner = addRunner(owner);
    const runs = finishedRuns(runner);
    await runner.start();

    const local = await owner.controller<AppendArgs, string>("reports");
    expect((await local.trigger()).outcome).toBe("started");
    await waitFor(() => runs.length === 1);
    expect(runs[0]?.record.source).toBe("manual");

    await local.pause();
    // No sync needed: the runner itself was paused.
    expect(runner.status).toBe("paused");
    expect(await local.trigger()).toEqual({
      outcome: "skipped",
      reason: "paused",
    });

    await local.updateSchedule(60_000);
    expect(runner.schedule).toEqual({ every: 60_000 });

    await local.resume();
    expect(runner.status).toBe("running");
  });

  it("reports who is running a run in flight, from the lock", async () => {
    const { owner, observer } = cluster();
    const runner = addRunner(owner, { args: { marker: "slow", ms: 400 } });
    await runner.start();

    const outcome = await runner.trigger();
    const remote = await observer.controller("reports");
    const info = await remote.info();

    expect(info.isRunning).toBe(true);
    expect(info.runningOn).toMatchObject({
      pid: process.pid,
      runId: outcome.outcome === "started" ? outcome.runId : "",
    });
    expect(info.runningOn!.since).toBeLessThanOrEqual(Date.now());
  });

  it("has no kill: a run can only be stopped where it executes", async () => {
    const { owner, observer } = cluster();
    await addRunner(owner).start();

    const remote = await observer.controller("reports");
    expect("kill" in remote).toBe(false);
    expect(remote).toBeInstanceOf(RunnerController);
  });
});

describe("BunRunnerManager.controller(): changes reach the owner", () => {
  it("applies pause, schedule and resume at once with control", async () => {
    const { owner, observer } = cluster();
    // No sync timer at all, so only the control event can deliver the change.
    const runner = addRunner(owner, { control: true, syncInterval: 0 });
    const events: string[] = [];
    runner.on("paused", () => events.push("paused"));
    runner.on("resumed", () => events.push("resumed"));
    await runner.start();

    const remote = await observer.controller("reports");

    await remote.pause();
    await waitFor(() => runner.status === "paused");
    expect(await runner.trigger()).toEqual({
      outcome: "skipped",
      reason: "paused",
    });

    await remote.updateSchedule({ every: 60_000 });
    await waitFor(() => runner.schedule !== null);
    expect(runner.schedule).toEqual({ every: 60_000 });
    expect(runner.nextRunAt()).not.toBeNull();

    await remote.resume();
    await waitFor(() => runner.status === "running");
    expect(events).toEqual(["paused", "resumed"]);
    expect((await remote.info()).isPaused).toBe(false);
  });

  it("applies them at the next sync with control off", async () => {
    const { owner, observer } = cluster();
    // Explicitly off: the memory driver's events are local, so the default
    // (`"auto"`) would subscribe and deliver them before the sync ever fired.
    const runner = addRunner(owner, { syncInterval: 40, control: false });
    await runner.start();

    const remote = await observer.controller("reports");
    await remote.pause();
    await waitFor(() => runner.status === "paused");

    await remote.resume({ triggerNow: true });
    const runs = finishedRuns(runner);
    await waitFor(() => runner.status === "running" && runs.length === 1);
    expect(runs[0]?.record.source).toBe("queued");
  });

  it("queues a trigger the owner runs, with its default args", async () => {
    const { owner, observer } = cluster();
    // `queueRuns` is off: a remote trigger is queued regardless.
    const runner = addRunner(owner, { control: true });
    const runs = finishedRuns(runner);
    await runner.start();

    const remote = await observer.controller<AppendArgs, string>("reports");

    expect(await remote.trigger()).toEqual({ outcome: "queued", position: 1 });
    await waitFor(() => runs.length === 1);
    expect(runs[0]?.record.source).toBe("queued");
    expect(runs[0]?.result.startsWith("default:")).toBe(true);

    await remote.trigger({ args: { marker: "remote", ms: 5 } });
    await waitFor(() => runs.length === 2);
    expect(runs[1]?.result.startsWith("remote:")).toBe(true);

    const history = await remote.history();
    expect(history.map((record) => record.source)).toEqual([
      "queued",
      "queued",
    ]);
    expect(history[0]?.result).toBe(runs[1]?.result);
    expect(await remote.stats()).toMatchObject({
      queued: 2,
      success: 2,
      total: 2,
      skipped: 0,
    });
    expect((await remote.info()).queuedTriggers).toBe(0);
  });

  it("skips a trigger while paused, unless forced", async () => {
    const { owner, observer } = cluster();
    const runner = addRunner(owner, { control: true });
    const runs = finishedRuns(runner);
    await runner.start();

    const remote = await observer.controller("reports");
    await remote.pause();
    await waitFor(() => runner.status === "paused");

    expect(await remote.trigger()).toEqual({
      outcome: "skipped",
      reason: "paused",
    });
    expect((await remote.stats()).skipped).toBe(1);

    expect((await remote.trigger({ force: true })).outcome).toBe("queued");
    await waitFor(() => runs.length === 1);
    expect(runner.status).toBe("paused");
  });

  it("drains remote triggers in parallel mode too", async () => {
    const { owner, observer } = cluster();
    const runner = addRunner(owner, {
      runMode: "parallel",
      control: true,
      args: { marker: "parallel", ms: 50 },
    });
    const runs = finishedRuns(runner);
    await runner.start();

    const remote = await observer.controller("reports");
    await remote.trigger();
    await remote.trigger();
    await waitFor(() => runs.length === 2);
    expect(runs.every((run) => run.record.source === "queued")).toBe(true);
  });

  it("runs a trigger queued while no owner was running when one starts", async () => {
    const { driver, namespace, owner, observer } = cluster();
    const first = addRunner(owner);
    await first.start();
    await first.stop();

    const remote = await observer.controller("reports");
    expect((await remote.trigger()).outcome).toBe("queued");
    expect((await remote.info()).queuedTriggers).toBe(1);

    const second = new BunRunner<AppendArgs, string>({
      id: "reports",
      namespace,
      driver,
      file: fixture("append"),
      executionMode: "in-process",
      waitToExit: false,
      syncInterval: 0,
      logger: noopLogger,
    });
    started.push(second);
    const runs = finishedRuns(second);
    await second.start();

    await waitFor(() => runs.length === 1);
    expect(runs[0]?.record.source).toBe("queued");
  });

  it("stops at the owner's maxQueuedRuns", async () => {
    const { owner, observer } = cluster();
    const runner = addRunner(owner, { maxQueuedRuns: 1 });
    await runner.start();
    // Stopped, so nothing drains what is queued.
    await runner.stop();

    const remote = await observer.controller("reports");
    expect(await remote.trigger()).toEqual({ outcome: "queued", position: 1 });
    expect(await remote.trigger()).toEqual({
      outcome: "skipped",
      reason: "queue-full",
    });
    expect(await remote.stats()).toMatchObject({ queued: 1, skipped: 1 });
  });
});

describe("BunRunnerManager.controller(): errors", () => {
  it("rejects an id nobody registered with RunnerNotFoundError", async () => {
    const { namespace, observer } = cluster();

    const error = await observer.controller("nope").catch((caught) => caught);
    expect(error).toBeInstanceOf(RunnerNotFoundError);
    expect(error).toBeInstanceOf(JobsError);
    expect(error).toMatchObject({
      name: "RunnerNotFoundError",
      code: "RUNNER_NOT_FOUND",
      context: { id: "nope", namespace },
    });

    // Looking did not create it.
    expect(await observer.discover()).not.toContain("nope");
  });

  it("rejects without a driver when the runner is not registered", async () => {
    const manager = new BunRunnerManager({ namespace: testNamespace() });
    expect(manager.controller("nope")).rejects.toBeInstanceOf(
      RunnerNotFoundError,
    );
  });

  it("rejects an unusable id with ConfigError", async () => {
    const { observer } = cluster();
    expect(observer.controller("not:valid")).rejects.toBeInstanceOf(
      ConfigError,
    );
  });

  it("rejects once the runner has been purged, and writes nothing", async () => {
    const { driver, namespace, owner, observer } = cluster();
    const runner = addRunner(owner);
    await runner.start();
    await runner.stop();

    const remote = await observer.controller("reports");
    await driver.purge(namespace);

    for (const call of [
      () => remote.pause(),
      () => remote.resume(),
      () => remote.updateSchedule(1000),
      () => remote.trigger(),
      () => remote.history(),
      () => remote.stats(),
      () => remote.info(),
    ]) {
      expect(call()).rejects.toBeInstanceOf(RunnerNotFoundError);
    }

    await Bun.sleep(10);
    expect(await observer.discover()).not.toContain("reports");
  });

  it("rejects a malformed schedule before writing it", async () => {
    const { owner, observer } = cluster();
    await addRunner(owner).start();

    const remote = await observer.controller("reports");
    expect(remote.updateSchedule("not a cron")).rejects.toBeInstanceOf(
      ConfigError,
    );
    expect((await remote.info()).schedule).toBeNull();
  });
});
