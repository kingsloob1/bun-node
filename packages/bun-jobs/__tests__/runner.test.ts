import type { BunRunnerOptions, RunRecord } from "../lib/index";
import { join } from "node:path";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import {
  BunRunner,
  BunRunnerManager,
  ConfigError,
  InvalidHandlerError,
  MemoryDriver,
  RunnerStoppedError,
} from "../lib/index";
import { toHandler } from "../lib/runner/executors/executor";
import { testNamespace, waitFor } from "./helpers";

/**
 * The runner, in-process.
 *
 * These tests are about the decision logic — what starts, what is queued,
 * what is skipped, and what is recorded — rather than about processes, which
 * `runner-modes.test.ts` covers once the spawn and worker executors land.
 */

/** Handler fixtures, resolved from this file. */
const fixture = (name: string) =>
  join(import.meta.dir, "fixtures", "handlers", `${name}.ts`);

/** Runners started by a test, stopped afterwards so nothing outlives it. */
const started: BunRunner<any, any>[] = [];

afterEach(async () => {
  await Promise.allSettled(
    started.map((runner) => runner.stop({ force: true })),
  );
  started.length = 0;
});

/** Builds a runner with the defaults these tests want, and tracks it. */
function makeRunner<TArgs = any, TResult = any>(
  options: Partial<BunRunnerOptions<TArgs>> & { file?: string } = {},
): BunRunner<TArgs, TResult> {
  const defaults = {
    id: "test-runner",
    namespace: testNamespace(),
    file: options.file ?? fixture("echo"),
    executionMode: "in-process",
    driver: new MemoryDriver(),
    waitToExit: false,
    // Handlers log; the assertions are on events, so keep the output quiet.
    logger: noopLogger,
  };

  const runner = new BunRunner<TArgs, TResult>({
    ...defaults,
    ...options,
  } as BunRunnerOptions<TArgs>);

  started.push(runner);
  return runner;
}

/** Resolves with the first `finished` event, or rejects on `failed`. */
function firstRun(runner: BunRunner<any, any>): Promise<{
  record: RunRecord;
  result: unknown;
}> {
  return new Promise((resolve, reject) => {
    runner.once("finished", (record, result) => {
      resolve({ record, result });
    });
    runner.once("failed", (record, error) => {
      reject(Object.assign(error, { record }));
    });
  });
}

describe("BunRunner: options", () => {
  it("requires a usable id and namespace", () => {
    expect(() => makeRunner({ id: "bad id" })).toThrow(ConfigError);
    expect(() => makeRunner({ namespace: "" })).toThrow(ConfigError);
    expect(() => makeRunner({ namespace: "a:b" })).toThrow(ConfigError);
  });

  it("rejects a file it cannot resolve", () => {
    expect(() => makeRunner({ file: "./nowhere.ts" })).toThrow(
      /Cannot resolve the runner file/,
    );
  });

  it("rejects a schedule that can never fire", () => {
    expect(() => makeRunner({ schedule: "not a cron" })).toThrow(ConfigError);
  });

  it("applies the documented defaults", () => {
    const runner = makeRunner({ executionMode: undefined });

    expect(runner.options).toMatchObject({
      name: "test-runner",
      runMode: "single",
      queueRuns: false,
      maxQueuedRuns: 100,
      timeout: 0,
      closeTimeout: 5000,
      killTimeout: 2000,
      lockTtl: 30_000,
      heartbeatInterval: 10_000,
      keepHistory: 50,
      onLockLost: "abort",
      autostart: false,
    });
    expect(runner.options.maxConcurrency).toBe(Number.POSITIVE_INFINITY);
  });

  it("does not start in the constructor", () => {
    expect(makeRunner().status).toBe("idle");
  });
});

describe("BunRunner: running a handler", () => {
  it("runs the file and reports its result", async () => {
    const runner = makeRunner({ args: { value: 42 } });
    await runner.start();

    const finished = firstRun(runner);
    const outcome = await runner.trigger();
    const { record, result } = await finished;

    expect(outcome).toMatchObject({ outcome: "started" });
    expect(record.status).toBe("success");
    expect(result).toMatchObject({
      value: 42,
      runnerId: "test-runner",
      namespace: runner.namespace,
      mode: "in-process",
      source: "manual",
    });
  });

  it("passes the trigger's arguments in preference to the runner's", async () => {
    const runner = makeRunner({ args: { value: "default" } });
    await runner.start();

    const finished = firstRun(runner);
    await runner.trigger({ args: { value: "override" } });

    expect((await finished).result).toMatchObject({ value: "override" });
  });

  it("reports a throwing handler as failed, with the error preserved", async () => {
    const runner = makeRunner({ file: fixture("throw") });
    await runner.start();

    const failure = await new Promise<{ record: RunRecord; error: Error }>(
      (resolve) => {
        runner.once("failed", (record, error) => resolve({ record, error }));
        void runner.trigger();
      },
    );

    expect(failure.record.status).toBe("failed");
    expect(failure.error.message).toBe("handler blew up");
    // The code survives serialisation, which is what a caller branches on.
    expect((failure.error as Error & { code?: string }).code).toBe("E_BOOM");
  });

  it("rejects a file whose default export is not a function", async () => {
    const runner = makeRunner({ file: fixture("not-a-handler") });
    await runner.start();

    const error = await new Promise<Error>((resolve) => {
      runner.once("failed", (_record, failure) => resolve(failure));
      void runner.trigger();
    });

    expect(error.name).toBe("InvalidHandlerError");
    expect(error.message).toContain("default export is object");
  });

  it("forwards progress, messages and logs", async () => {
    const runner = makeRunner({
      file: fixture("progress"),
      args: { steps: 2 },
    });
    await runner.start();

    const progress: unknown[] = [];
    const messages: unknown[] = [];
    runner.on("progress", (_record, value) => progress.push(value));
    runner.on("message", (_record, data) => messages.push(data));

    const finished = firstRun(runner);
    const outcome = await runner.trigger();

    // A message sent to the run comes back through the context's listener.
    if (outcome.outcome === "started") {
      runner.send({ ping: true }, outcome.runId);
    }

    expect((await finished).result).toBe(2);
    expect(progress).toEqual([
      { step: 1, of: 2 },
      { step: 2, of: 2 },
    ]);
    expect(messages).toEqual([{ echo: { ping: true } }]);
  });

  it("carries declared message types both ways without a cast", async () => {
    const runner = new BunRunner<
      { steps: number },
      number,
      { ping: boolean },
      { echo: { ping: boolean } }
    >({
      id: "typed-messages",
      namespace: testNamespace(),
      file: fixture("progress"),
      executionMode: "in-process",
      driver: new MemoryDriver(),
      waitToExit: false,
      logger: noopLogger,
      args: { steps: 2 },
    });
    started.push(runner);
    await runner.start();

    const echoes: { ping: boolean }[] = [];
    runner.on("message", (_record, data) => echoes.push(data.echo));

    const finished = firstRun(runner);
    const outcome = await runner.trigger();
    if (outcome.outcome === "started") {
      expect(runner.send({ ping: true }, outcome.runId)).toBe(true);
    }

    expect((await finished).result).toBe(2);
    expect(echoes).toEqual([{ ping: true }]);
  });

  it("kills nothing, and resolves, for a run id it does not know", async () => {
    const runner = makeRunner();
    await runner.start();

    await runner.kill("no-such-run");

    expect(runner.activeRuns.size).toBe(0);
    expect(runner.send({ ping: true }, "no-such-run")).toBe(false);
  });

  it("reads a handler the same way whichever way it will be called", () => {
    const handler = () => 1;

    // `kind` changes only the declared return type, never the check.
    expect(toHandler({ default: handler }, "f.ts")).toBe(handler);
    expect(toHandler({ default: handler }, "f.ts", "run")).toBe(handler);
    expect(toHandler({ default: handler }, "f.ts", "job")).toBe(handler);
    expect(toHandler(handler, "f.ts", "job")).toBe(handler);
    expect(() => toHandler({}, "f.ts", "job")).toThrow(InvalidHandlerError);
    expect(() => toHandler(42, "f.ts")).toThrow(InvalidHandlerError);
  });

  it("aborts an over-running handler and reports the timeout", async () => {
    const runner = makeRunner({
      file: fixture("sleep"),
      args: { ms: 5000 },
      timeout: 30,
    });
    await runner.start();

    const outcome = await new Promise<RunRecord>((resolve) => {
      runner.once("timeout", resolve);
      void runner.trigger();
    });

    expect(outcome.status).toBe("timeout");
    // The fixture honours its signal, so the run really did stop.
    expect(outcome.detached).toBeUndefined();
  });

  it("marks a run detached when the handler ignores its abort", async () => {
    const runner = makeRunner({
      file: fixture("hang"),
      args: { ms: 400 },
      timeout: 20,
      closeTimeout: 30,
    });
    await runner.start();

    const record = await new Promise<RunRecord>((resolve) => {
      runner.once("timeout", resolve);
      void runner.trigger();
    });

    // Honest reporting: this process could not stop the work.
    expect(record.detached).toBe(true);
  });

  it("kills a run on request", async () => {
    const runner = makeRunner({ file: fixture("sleep"), args: { ms: 5000 } });
    await runner.start();

    const outcome = await runner.trigger();
    expect(outcome.outcome).toBe("started");

    if (outcome.outcome === "started") {
      await runner.kill(outcome.runId, { reason: "test" });
    }

    expect(runner.activeRuns.size).toBe(0);
  });
});

describe("BunRunner: history, stats and info", () => {
  it("records each run, newest first, trimmed to keepHistory", async () => {
    const runner = makeRunner({ keepHistory: 2 });
    await runner.start();

    for (let i = 0; i < 3; i++) {
      const finished = firstRun(runner);
      await runner.trigger({ args: { value: i } });
      await finished;
    }

    const history = await runner.history();
    expect(history).toHaveLength(2);
    expect(history[0].status).toBe("success");
    expect(history[0].startedAt).toBeGreaterThanOrEqual(history[1].startedAt);
    expect(history[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("counts outcomes and resets them", async () => {
    const runner = makeRunner();
    await runner.start();

    const finished = firstRun(runner);
    await runner.trigger();
    await finished;

    expect(await runner.stats()).toMatchObject({
      success: 1,
      total: 1,
      failed: 0,
    });

    await runner.resetStats();
    expect(await runner.stats()).toMatchObject({ success: 0, total: 0 });
  });

  it("counts a failure as failed without counting it as success", async () => {
    const runner = makeRunner({ file: fixture("throw") });
    await runner.start();

    await new Promise<void>((resolve) => {
      runner.once("failed", () => resolve());
      void runner.trigger();
    });

    expect(await runner.stats()).toMatchObject({
      success: 0,
      failed: 1,
      total: 1,
    });
  });

  it("describes itself", async () => {
    const runner = makeRunner({ schedule: 60_000 });
    await runner.start();

    const finished = firstRun(runner);
    await runner.trigger();
    await finished;

    const info = await runner.info();
    expect(info).toMatchObject({
      id: "test-runner",
      name: "test-runner",
      namespace: runner.namespace,
      runMode: "single",
      executionMode: "in-process",
      isPaused: false,
      queuedTriggers: 0,
    });
    expect(info.schedule).toEqual({ every: 60_000 });
    expect(info.nextRunAt).toBeInstanceOf(Date);
    expect(info.lastRun?.status).toBe("success");
    expect(info.stats.success).toBe(1);
  });

  it("reports the last error", async () => {
    const runner = makeRunner({ file: fixture("throw") });
    await runner.start();

    await new Promise<void>((resolve) => {
      runner.once("failed", () => resolve());
      void runner.trigger();
    });

    expect((await runner.info()).lastError).toMatchObject({
      message: "handler blew up",
    });
  });
});

describe("BunRunner: pausing and scheduling", () => {
  it("skips triggers while paused, and persists the flag", async () => {
    const runner = makeRunner();
    await runner.start();
    await runner.pause();

    expect(runner.status).toBe("paused");
    expect(await runner.trigger()).toEqual({
      outcome: "skipped",
      reason: "paused",
    });
    // The flag lives in the driver, so every process sees it.
    expect((await runner.info()).isPaused).toBe(true);

    await runner.resume();
    expect(runner.status).toBe("running");

    const finished = firstRun(runner);
    expect((await runner.trigger()).outcome).toBe("started");
    await finished;
  });

  it("runs while paused when forced", async () => {
    const runner = makeRunner();
    await runner.start();
    await runner.pause();

    const finished = firstRun(runner);
    expect((await runner.trigger({ force: true })).outcome).toBe("started");
    await finished;
  });

  it("fires a run on resume when asked", async () => {
    const runner = makeRunner();
    await runner.start();
    await runner.pause();

    const finished = firstRun(runner);
    await runner.resume({ triggerNow: true });
    expect((await finished).record.source).toBe("resume");
  });

  it("restores a paused flag another process set", async () => {
    const driver = new MemoryDriver();
    const namespace = testNamespace();

    const first = makeRunner({ id: "shared", namespace, driver });
    await first.start();
    await first.pause();

    // A second instance of the same runner, as another process would build.
    const second = makeRunner({ id: "shared", namespace, driver });
    await second.start();

    expect(second.status).toBe("paused");
    expect(await second.trigger()).toEqual({
      outcome: "skipped",
      reason: "paused",
    });
  });

  it("re-arms the ticker when the schedule changes", async () => {
    const runner = makeRunner({ schedule: 3_600_000 });
    await runner.start();

    const before = runner.nextRunAt();
    await runner.updateSchedule(60_000);
    const after = runner.nextRunAt();

    expect(runner.schedule).toEqual({ every: 60_000 });
    expect(after!.getTime()).toBeLessThan(before!.getTime());
    // Persisted, so another process picks it up.
    expect((await runner.info()).schedule).toEqual({ every: 60_000 });
  });

  it("fires on its schedule", async () => {
    const runner = makeRunner({ schedule: 20 });
    const finished: number[] = [];
    runner.on("finished", () => finished.push(Date.now()));

    await runner.start();
    await waitFor(() => finished.length >= 2, {
      message: "scheduled runs did not fire",
    });

    const history = await runner.history();
    expect(history[0].source).toBe("schedule");
  });
});

describe("BunRunner: stopping", () => {
  it("refuses manual triggers once stopped", async () => {
    const runner = makeRunner();
    await runner.start();
    await runner.stop();

    expect(runner.status).toBe("stopped");
    await expect(runner.trigger()).rejects.toThrow(RunnerStoppedError);
  });

  it("skips rather than throws for a scheduled trigger after stopping", async () => {
    const runner = makeRunner();
    await runner.start();
    await runner.stop();

    expect(await runner.trigger({ source: "schedule" })).toEqual({
      outcome: "skipped",
      reason: "stopped",
    });
  });

  it("waits for a run in flight", async () => {
    const runner = makeRunner({ file: fixture("sleep"), args: { ms: 40 } });
    await runner.start();
    await runner.trigger();

    await runner.stop({ timeout: 1000 });

    expect(runner.activeRuns.size).toBe(0);
    expect((await runner.history())[0].status).toBe("success");
  });

  it("is safe to stop twice", async () => {
    const runner = makeRunner();
    await runner.start();
    await runner.stop();
    await runner.stop();
  });
});

describe("BunRunnerManager", () => {
  it("registers, lists and removes runners", async () => {
    const namespace = testNamespace();
    const manager = new BunRunnerManager({
      namespace,
      driver: new MemoryDriver(),
    });

    const first = manager.add({
      id: "first",
      file: fixture("echo"),
      executionMode: "in-process",
      waitToExit: false,
    });
    manager.add({
      id: "second",
      file: fixture("echo"),
      executionMode: "in-process",
      waitToExit: false,
    });
    started.push(first, manager.get("second")!);

    expect(manager.size).toBe(2);
    expect(manager.list().map((runner) => runner.id)).toEqual([
      "first",
      "second",
    ]);
    expect(manager.get("first")).toBe(first);
    expect(first.namespace).toBe(namespace);

    expect(await manager.remove("second")).toBe(true);
    expect(await manager.remove("second")).toBe(false);
    expect(manager.size).toBe(1);
  });

  it("refuses a duplicate id instead of overwriting", () => {
    const manager = new BunRunnerManager({ namespace: testNamespace() });
    const options = {
      id: "dupe",
      file: fixture("echo"),
      executionMode: "in-process" as const,
      driver: new MemoryDriver(),
      waitToExit: false,
    };

    started.push(manager.add(options));
    // Two runners sharing an id would quietly share a lock.
    expect(() => manager.add(options)).toThrow(/already registered/);
  });

  it("refuses a runner from another namespace", () => {
    const manager = new BunRunnerManager({ namespace: testNamespace() });
    const foreign = makeRunner({ id: "foreign", namespace: testNamespace() });

    expect(() => manager.add(foreign)).toThrow(/belongs to namespace/);
  });

  it("starts and stops every runner together", async () => {
    const manager = new BunRunnerManager({
      namespace: testNamespace(),
      driver: new MemoryDriver(),
    });

    for (const id of ["a", "b"]) {
      started.push(
        manager.add({
          id,
          file: fixture("echo"),
          executionMode: "in-process",
          waitToExit: false,
        }),
      );
    }

    await manager.startAll();
    expect(manager.list().every((runner) => runner.status === "running")).toBe(
      true,
    );

    await manager.stopAll();
    expect(manager.list().every((runner) => runner.status === "stopped")).toBe(
      true,
    );
  });

  it("reports what the backend knows, not just what it holds", async () => {
    const driver = new MemoryDriver();
    const namespace = testNamespace();
    const manager = new BunRunnerManager({ namespace, driver });

    const runner = manager.add({
      id: "known",
      file: fixture("echo"),
      executionMode: "in-process",
      waitToExit: false,
    });
    started.push(runner);
    await runner.start();

    expect(await manager.discover()).toContain("known");
    expect((await manager.info())[0]).toMatchObject({ id: "known", namespace });
  });
});
