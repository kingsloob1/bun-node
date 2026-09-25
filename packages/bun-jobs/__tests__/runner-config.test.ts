import type { BunRunnerOptions, RunRecord } from "../lib/index";
import { join } from "node:path";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import {
  BunJobs,
  BunRunner,
  BunRunnerManager,
  ConfigError,
  FileDriver,
  MemoryDriver,
  RUNNER_CONFIG_STATE,
  runnerKey,
} from "../lib/index";
import { makeTmpDir, testNamespace, waitFor } from "./helpers";

/**
 * Remote runner configuration: changing a runner's `executionMode` and its
 * overlap settings from another process.
 *
 * Two managers over one memory driver stand in for two processes — one owns
 * the runner, the other only knows its id — exactly as `runner-remote.test.ts`
 * does. What the controller writes reaches the owner through the backend
 * alone; `runner-config-crossprocess.test.ts` proves the same with genuinely
 * separate processes, and on every backend.
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

/** The state key every runner in this suite lives under. */
const KEY = runnerKey("configurable");

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
  const namespace = testNamespace("runner-config");
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
    id: "configurable",
    file: fixture("append"),
    executionMode: "in-process",
    // A config a child could be handed: without one, an override asking for
    // `spawn` or `worker` is refused, which its own test covers.
    childDriver: { type: "memory" },
    waitToExit: false,
    syncInterval: 0,
    args: { marker: "default", ms: 5 },
    ...options,
  });
  started.push(runner);
  return runner;
}

describe("remote runner configuration", () => {
  it("reports the code values, and no override, before anything is written", async () => {
    const { owner } = cluster();
    const runner = addRunner(owner, {
      runMode: "parallel",
      maxConcurrency: 3,
    });
    await runner.start();

    const info = await runner.info();
    expect(info.config).toMatchObject({
      effective: {
        executionMode: "in-process",
        runMode: "parallel",
        maxConcurrency: 3,
      },
      code: {
        executionMode: "in-process",
        runMode: "parallel",
        maxConcurrency: 3,
      },
      overridden: [],
      allowed: ["spawn", "worker", "in-process"],
      seq: 0,
    });
    expect(info.config.error).toBeUndefined();
  });

  it("reports an override as stored but not yet adopted, then adopted", async () => {
    const { owner, observer } = cluster();
    const runner = addRunner(owner, {
      runMode: "parallel",
      maxConcurrency: 3,
      syncInterval: 25,
      // The sync is what this test watches. The memory driver's events are
      // local, so `control: "auto"` would subscribe and the owner would
      // have adopted before the write returned — the path `control: true`
      // has its own test below.
      control: false,
    });
    await runner.start();

    const remote = await observer.controller<AppendArgs, string>(
      "configurable",
    );
    const written = await remote.updateConfig({
      concurrency: { runMode: "parallel", maxConcurrency: 1 },
    });

    // `effective` is what is in force, which is still the code's value: no
    // owner has adopted the write yet, and `appliedSeq` says exactly that.
    expect(written.effective.maxConcurrency).toBe(3);
    expect(written.overridden).toEqual(["runMode", "maxConcurrency"]);
    expect(written.seq).toBeGreaterThan(written.appliedSeq ?? 0);

    await waitFor(() => runner.maxConcurrency === 1, {
      timeout: 4000,
      message: () => `still ${runner.maxConcurrency}`,
    });

    const adopted = await remote.config();
    expect(adopted?.effective.maxConcurrency).toBe(1);
    expect(adopted?.appliedSeq).toBe(adopted?.seq);
  });

  it("delegates to the runner registered in this process, as pause does", async () => {
    const { owner } = cluster();
    const runner = addRunner(owner);
    await runner.start();

    const remote = await owner.controller<AppendArgs, string>("configurable");
    expect(remote.isLocal).toBe(true);

    await remote.updateConfig({ executionMode: "spawn" });

    // No sync, no event: the controller called the runner itself.
    expect(runner.executionMode).toBe("spawn");
  });

  it("adopts a stored override at start(), so a restart keeps it", async () => {
    const { driver, namespace, owner, observer } = cluster();

    const first = addRunner(owner, { runMode: "parallel" });
    await first.start();

    const remote = await observer.controller<AppendArgs, string>(
      "configurable",
    );
    await remote.updateConfig({
      concurrency: { runMode: "parallel", maxConcurrency: 2 },
    });
    await first.stop();

    // A fresh instance, as a redeployed process would build: it knows only
    // its own options, and reads the override out of the backend.
    const second = new BunRunner<AppendArgs, string>({
      id: "configurable",
      namespace,
      driver,
      file: fixture("append"),
      executionMode: "in-process",
      runMode: "parallel",
      maxConcurrency: 8,
      waitToExit: false,
      syncInterval: 0,
      logger: noopLogger,
    });
    started.push(second);

    expect(second.maxConcurrency).toBe(8);
    await second.start();
    expect(second.maxConcurrency).toBe(2);
    expect(second.config.code?.maxConcurrency).toBe(8);
  });

  it("adopts an override at the next sync", async () => {
    const { owner, observer } = cluster();
    const runner = addRunner(owner, { syncInterval: 25 });
    await runner.start();

    const remote = await observer.controller<AppendArgs, string>(
      "configurable",
    );
    await remote.updateConfig({ executionMode: "worker" });

    await waitFor(() => runner.executionMode === "worker", {
      timeout: 4000,
      message: () => `still ${runner.executionMode}`,
    });
  });

  it("adopts an override on the control event, with control on", async () => {
    const { owner, observer } = cluster();
    // No sync at all: only the `control` event can carry this.
    const runner = addRunner(owner, { syncInterval: 0, control: true });
    await runner.start();

    const remote = await observer.controller<AppendArgs, string>(
      "configurable",
    );
    await remote.updateConfig({ executionMode: "worker" });

    await waitFor(() => runner.executionMode === "worker", {
      timeout: 4000,
      message: () => `still ${runner.executionMode}`,
    });
  });

  it("emits `configured` only when a value actually changed", async () => {
    const { owner } = cluster();
    const runner = addRunner(owner);
    const seen: string[] = [];
    runner.on("configured", (config) => seen.push(config.effective.runMode));
    await runner.start();

    const remote = await owner.controller<AppendArgs, string>("configurable");
    await remote.updateConfig({
      concurrency: { runMode: "parallel", maxConcurrency: 2 },
    });
    // The same values again: nothing changed, so nothing is announced.
    await remote.updateConfig({
      concurrency: { runMode: "parallel", maxConcurrency: 2 },
    });

    expect(seen).toEqual(["parallel"]);
  });

  it("writes the effective values under their original names, for older clients", async () => {
    const { driver, namespace, owner, observer } = cluster();
    const runner = addRunner(owner, { runMode: "parallel", syncInterval: 25 });
    await runner.start();

    const remote = await observer.controller<AppendArgs, string>(
      "configurable",
    );
    await remote.updateConfig({ executionMode: "worker" });
    await waitFor(() => runner.executionMode === "worker", { timeout: 4000 });

    const state = await driver.getState(namespace, KEY);
    expect(state.executionMode).toBe("worker");
    expect(state[RUNNER_CONFIG_STATE.executionMode]).toBe("worker");
    expect(JSON.parse(state[RUNNER_CONFIG_STATE.code] ?? "{}")).toMatchObject({
      executionMode: "in-process",
    });

    // And the shape a controller with no owner in its process reads.
    const info = await remote.info();
    expect(info.executionMode).toBe("worker");
    expect(info.config?.effective.executionMode).toBe("worker");
    expect(info.config?.code?.executionMode).toBe("in-process");
    expect(info.config?.overridden).toEqual(["executionMode"]);
    expect(info.config?.appliedSeq).toBe(info.config?.seq);
  });

  it("resets to the code values and keeps the version rising", async () => {
    const { owner, observer } = cluster();
    const runner = addRunner(owner, {
      runMode: "parallel",
      maxConcurrency: 5,
    });
    await runner.start();

    const remote = await observer.controller<AppendArgs, string>(
      "configurable",
    );
    const overridden = await remote.updateConfig({
      executionMode: "worker",
      concurrency: { runMode: "single" },
    });
    // `single` has no cap to bound, so the concurrency patch clears that
    // override rather than storing one nothing would read.
    expect(overridden.overridden).toEqual(["executionMode", "runMode"]);

    const reset = await remote.resetConfig();
    expect(reset.overridden).toEqual([]);
    expect(reset.effective).toEqual({
      executionMode: "in-process",
      runMode: "parallel",
      maxConcurrency: 5,
    });
    // A delete would restart the version at 1 and make an old `appliedSeq`
    // look current, so a reset bumps it like any other write.
    expect(reset.seq).toBeGreaterThan(overridden.seq);
    expect(runner.executionMode).toBe("in-process");
    expect(runner.maxConcurrency).toBe(5);
  });

  it("clears an unlimited cap and stores it as such", async () => {
    const { owner } = cluster();
    const runner = addRunner(owner, {
      runMode: "parallel",
      maxConcurrency: 2,
    });
    await runner.start();

    const remote = await owner.controller<AppendArgs, string>("configurable");
    const config = await remote.updateConfig({
      concurrency: { runMode: "parallel", maxConcurrency: null },
    });

    expect(config.effective.maxConcurrency).toBeNull();
    expect(runner.maxConcurrency).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("remote runner configuration — validation", () => {
  it("refuses an execution mode the runner's code does not permit", async () => {
    const { owner, observer } = cluster();
    const runner = addRunner(owner, {
      allowedOverrides: { executionModes: ["in-process", "worker"] },
    });
    await runner.start();

    const remote = await observer.controller<AppendArgs, string>(
      "configurable",
    );
    const failure = await remote
      .updateConfig({ executionMode: "spawn" })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ConfigError);
    expect((failure as ConfigError).context).toMatchObject({
      reason: "not-allowed",
      executionMode: "spawn",
      allowed: ["worker", "in-process"],
    });
    expect(runner.executionMode).toBe("in-process");
  });

  it("refuses a cap outside the contract's bounds, and an empty patch", async () => {
    const { owner } = cluster();
    const runner = addRunner(owner);
    await runner.start();

    const remote = await owner.controller<AppendArgs, string>("configurable");

    for (const maxConcurrency of [0, 1001, 2.5]) {
      const failure = await remote
        .updateConfig({ concurrency: { runMode: "parallel", maxConcurrency } })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ConfigError);
      expect((failure as ConfigError).context).toMatchObject({
        reason: "invalid",
        field: "maxConcurrency",
      });
    }

    const empty = await remote
      .updateConfig({})
      .catch((error: unknown) => error);
    expect((empty as ConfigError).context).toMatchObject({ reason: "empty" });
  });

  it("drops an override the owner cannot honour and records why", async () => {
    const { driver, namespace, owner } = cluster();
    const runner = addRunner(owner, {
      runMode: "parallel",
      maxConcurrency: 4,
      syncInterval: 25,
      allowedOverrides: { executionModes: ["in-process"] },
    });
    await runner.start();

    // Written straight into state, as a controller from a build that allowed
    // more — or a hand edit — would leave it.
    await driver.setState(namespace, KEY, {
      [RUNNER_CONFIG_STATE.executionMode]: "spawn",
      [RUNNER_CONFIG_STATE.maxConcurrency]: "9000",
      [RUNNER_CONFIG_STATE.runMode]: "single",
    });
    await driver.incrementCounters(namespace, KEY, {
      [RUNNER_CONFIG_STATE.seq]: 1,
    });

    await waitFor(() => runner.config.error !== undefined, {
      timeout: 4000,
      message: () => JSON.stringify(runner.config),
    });

    const config = runner.config;
    // The runMode override is fine, so it is adopted; the other two are not.
    expect(config.effective.runMode).toBe("single");
    expect(config.effective.executionMode).toBe("in-process");
    expect(config.effective.maxConcurrency).toBe(4);
    expect(config.error?.message).toContain("in-process");
    expect(config.error?.message).toContain("9000");
    // And names the two it refused, in contract order.
    expect(config.error?.keys).toEqual(["executionMode", "maxConcurrency"]);
    // The refusal is persisted, so a controller elsewhere sees it too.
    const stored = await driver.getState(namespace, KEY);
    expect(stored[RUNNER_CONFIG_STATE.error]).toContain("9000");
  });

  it("refuses spawn and worker when the runner has no driver config for a child", async () => {
    const driver = new MemoryDriver();
    const namespace = testNamespace("runner-config");
    // Built from a driver *instance*: there is nothing a child could be
    // handed to reach the backend with.
    const runner = new BunRunner<AppendArgs, string>({
      id: "configurable",
      namespace,
      driver,
      file: fixture("append"),
      executionMode: "in-process",
      waitToExit: false,
      syncInterval: 25,
      logger: noopLogger,
    });
    started.push(runner);
    await runner.start();

    // B17: the owner publishes only what it can adopt, so a controller now
    // refuses up front instead of storing an override the owner then drops.
    // (That owner-side refusal is still covered, for an override stored
    // before the owner started, in `fix-runner-b17.test.ts`.)
    expect(runner.config.allowed).toEqual(["in-process"]);
    const manager = new BunRunnerManager({
      namespace,
      driver,
      logger: noopLogger,
    });
    const remote = await manager.controller<AppendArgs, string>("configurable");
    await expect(
      remote.updateConfig({ executionMode: "spawn" }),
    ).rejects.toThrow(/does not permit executionMode "spawn"/);
    expect(runner.executionMode).toBe("in-process");
    expect(runner.config.overridden).toEqual([]);
  });

  it("refuses to store an override no owner would ever adopt", async () => {
    const { driver, namespace, owner, observer } = cluster();
    const runner = addRunner(owner);
    await runner.start();
    await runner.stop();
    // What a runner last started by a build without remote configuration
    // leaves behind: state, but no `config:code`.
    await driver.setState(namespace, KEY, {
      [RUNNER_CONFIG_STATE.code]: null,
      [RUNNER_CONFIG_STATE.allowed]: null,
    });

    const remote = await observer.controller("configurable");
    const failure = await remote
      .updateConfig({ executionMode: "worker" })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ConfigError);
    expect((failure as ConfigError).context).toMatchObject({
      reason: "not-configurable",
    });
    expect(await remote.config()).toBeUndefined();
    expect((await remote.info()).config).toBeUndefined();
  });

  it("rejects a allowedOverrides option that permits nothing, or nonsense", () => {
    const driver = new MemoryDriver();
    const namespace = testNamespace("runner-config");
    const build = (executionModes: string[]) =>
      new BunRunner({
        id: "configurable",
        namespace,
        driver,
        file: fixture("append"),
        waitToExit: false,
        logger: noopLogger,
        allowedOverrides: {
          executionModes: executionModes as ("spawn" | "worker")[],
        },
      });

    expect(() => build([])).toThrow(ConfigError);
    expect(() => build(["threads"])).toThrow(ConfigError);
  });
});

describe("remote runner configuration — semantics", () => {
  it("keeps a run in flight on the mode it started with", async () => {
    const { owner } = cluster();
    const runner = addRunner(owner, {
      runMode: "parallel",
      maxConcurrency: 4,
      args: { marker: "slow", ms: 400 },
      // A config, so spawn is honoured rather than refused.
      driver: { type: "memory" },
    });
    await runner.start();

    const records: RunRecord[] = [];
    runner.on("finished", (record) => records.push({ ...record }));

    await runner.trigger();
    await waitFor(() => runner.activeRuns.size === 1);

    const remote = await owner.controller<AppendArgs, string>("configurable");
    await remote.updateConfig({ executionMode: "spawn" });
    expect(runner.executionMode).toBe("spawn");

    await waitFor(() => records.length === 1, { timeout: 5000 });
    expect(records[0]?.mode).toBe("in-process");

    // And the next one uses the new mode.
    await runner.trigger({ args: { marker: "fast", ms: 5 } });
    await waitFor(() => records.length === 2, { timeout: 20_000 });
    expect(records[1]?.mode).toBe("spawn");
  }, 30_000);

  it("gates only new runs when the cap is lowered", async () => {
    const { owner } = cluster();
    const runner = addRunner(owner, {
      runMode: "parallel",
      maxConcurrency: 3,
      queueRuns: true,
      args: { marker: "slow", ms: 300 },
    });
    await runner.start();

    await runner.trigger();
    await runner.trigger();
    await waitFor(() => runner.activeRuns.size === 2);

    const remote = await owner.controller<AppendArgs, string>("configurable");
    await remote.updateConfig({
      concurrency: { runMode: "parallel", maxConcurrency: 1 },
    });

    // Neither run is killed …
    expect(runner.activeRuns.size).toBe(2);
    // … and nothing new starts.
    const outcome = await runner.trigger();
    expect(outcome.outcome).toBe("queued");
  });

  it("releases a stranded lock after single → parallel", async () => {
    const { driver, namespace, owner } = cluster();
    const runner = addRunner(owner, {
      runMode: "single",
      args: { marker: "slow", ms: 250 },
    });
    await runner.start();

    await runner.trigger();
    await waitFor(() => runner.activeRuns.size === 1);
    expect(await driver.getLock(namespace, KEY, Date.now())).not.toBeNull();

    const remote = await owner.controller<AppendArgs, string>("configurable");
    await remote.updateConfig({
      concurrency: { runMode: "parallel", maxConcurrency: 4 },
    });

    // The run that holds the lock finishes in parallel mode, where the old
    // drain released nothing: the lock would then sit there until its TTL.
    await waitFor(() => runner.activeRuns.size === 0, { timeout: 5000 });
    await waitFor(
      async () => (await driver.getLock(namespace, KEY, Date.now())) === null,
      {
        timeout: 4000,
        message: "the lock was never released",
      },
    );
  });

  it("migrates parked triggers into the driver queue on parallel → single", async () => {
    const { driver, namespace, owner } = cluster();
    const runner = addRunner(owner, {
      runMode: "parallel",
      maxConcurrency: 1,
      queueRuns: true,
      maxQueuedRuns: 10,
      args: { marker: "slow", ms: 250 },
    });
    await runner.start();

    await runner.trigger();
    await waitFor(() => runner.activeRuns.size === 1);
    expect((await runner.trigger()).outcome).toBe("queued");
    expect(await driver.countQueuedTriggers(namespace, KEY)).toBe(0);

    const remote = await owner.controller<AppendArgs, string>("configurable");
    await remote.updateConfig({ concurrency: { runMode: "single" } });

    // Single mode never drains the local queue, so the parked trigger has to
    // move to the one it does drain — otherwise it waits for ever.
    expect(await driver.countQueuedTriggers(namespace, KEY)).toBe(1);

    const finished: string[] = [];
    runner.on("finished", (record) => finished.push(record.runId));
    await waitFor(() => finished.length === 2, {
      timeout: 6000,
      message: () => `only ${finished.length} run(s) happened`,
    });
  });

  it("counts a migrated trigger that no longer fits as skipped", async () => {
    const { driver, namespace, owner, observer } = cluster();
    const runner = addRunner(owner, {
      runMode: "parallel",
      maxConcurrency: 1,
      queueRuns: true,
      maxQueuedRuns: 1,
      args: { marker: "slow", ms: 250 },
    });
    await runner.start();

    await runner.trigger();
    await waitFor(() => runner.activeRuns.size === 1);
    // One parked here …
    expect((await runner.trigger()).outcome).toBe("queued");
    // … and one already in the driver's queue, which is now at its cap.
    const remote = await observer.controller<AppendArgs, string>(
      "configurable",
    );
    expect((await remote.trigger()).outcome).toBe("queued");

    const before = (await runner.stats()).skipped;
    const local = await owner.controller<AppendArgs, string>("configurable");
    await local.updateConfig({ concurrency: { runMode: "single" } });

    expect(await driver.countQueuedTriggers(namespace, KEY)).toBe(1);
    expect((await runner.stats()).skipped).toBe(before + 1);
  });
});

/**
 * `control` decides whether a runner *subscribes* to its `control`
 * events or waits for its sync. The option is authoritative wherever it is
 * given; `"auto"` — the default — asks the driver, and listens only where a
 * subscription costs nothing: the same rule `BunQueueWorker` resolves its own
 * `control.subscribe` with.
 */
describe("control defaults to listening where it is cheap", () => {
  /** The resolved option, for one driver and one spelling. */
  function resolvedFor(
    driver: MemoryDriver | FileDriver,
    control?: boolean | "auto",
  ): boolean {
    const manager = new BunRunnerManager({
      namespace: testNamespace("runner-auto"),
      driver,
      logger: noopLogger,
    });
    const runner = manager.add<AppendArgs, string>({
      id: "configurable",
      file: fixture("append"),
      executionMode: "in-process",
      waitToExit: false,
      syncInterval: 0,
      ...(control === undefined ? {} : { control }),
    });
    started.push(runner);
    return runner.options.control;
  }

  it("subscribes on a driver whose events are local or pushed, not on one that polls", async () => {
    const tmp = await makeTmpDir("runner-auto");
    try {
      const memory = new MemoryDriver();
      const file = new FileDriver({ root: tmp.path });

      // Unset and `"auto"` are the same thing, and the driver decides.
      expect(memory.capabilities.events).toBe("local");
      expect(file.capabilities.events).toBe("poll");
      expect(resolvedFor(memory)).toBe(true);
      expect(resolvedFor(memory, "auto")).toBe(true);
      expect(resolvedFor(file)).toBe(false);
      expect(resolvedFor(file, "auto")).toBe(false);

      // An explicit value still means exactly what it says, either way.
      expect(resolvedFor(file, true)).toBe(true);
      expect(resolvedFor(memory, false)).toBe(false);

      await file.close?.();
    } finally {
      await tmp.cleanup();
    }
  });

  it("adopts a remote change with no sync at all, because the default subscribed", async () => {
    const { owner, observer } = cluster();
    // No sync timer, no `control`: only the subscription the default
    // takes out on the memory driver can deliver this.
    const runner = addRunner(owner, {
      runMode: "parallel",
      maxConcurrency: 3,
      syncInterval: 0,
    });
    expect(runner.options.control).toBe(true);
    await runner.start();

    const remote = await observer.controller<AppendArgs, string>(
      "configurable",
    );
    await remote.updateConfig({
      concurrency: { runMode: "parallel", maxConcurrency: 1 },
    });

    await waitFor(() => runner.maxConcurrency === 1, {
      timeout: 2000,
      message: () => `still ${runner.maxConcurrency}`,
    });
  });

  it("does not adopt one without a sync when the option is off", async () => {
    const { owner, observer } = cluster();
    const runner = addRunner(owner, {
      runMode: "parallel",
      maxConcurrency: 3,
      syncInterval: 0,
      control: false,
    });
    await runner.start();

    const remote = await observer.controller<AppendArgs, string>(
      "configurable",
    );
    await remote.updateConfig({
      concurrency: { runMode: "parallel", maxConcurrency: 1 },
    });

    // Nothing delivers it: no subscription, and no sync to fall back on.
    await Bun.sleep(150);
    expect(runner.maxConcurrency).toBe(3);
  });

  it("gives a runner created through BunJobs the same default", async () => {
    const jobs = new BunJobs({
      namespace: testNamespace("runner-auto-ctx"),
      driver: new MemoryDriver(),
      logger: noopLogger,
    });
    try {
      const runner = jobs.runner<AppendArgs, string>({
        id: "configurable",
        file: fixture("append"),
        executionMode: "in-process",
        waitToExit: false,
      });
      expect(runner.options.control).toBe(true);

      // And `runnerDefaults` still wins, as every other option does.
      const off = new BunJobs({
        namespace: testNamespace("runner-auto-off"),
        driver: new MemoryDriver(),
        logger: noopLogger,
        runnerDefaults: { control: false },
      });
      const quiet = off.runner<AppendArgs, string>({
        id: "quiet",
        file: fixture("append"),
        executionMode: "in-process",
        waitToExit: false,
      });
      expect(quiet.options.control).toBe(false);
      await off.close();
    } finally {
      await jobs.close();
    }
  });
});
