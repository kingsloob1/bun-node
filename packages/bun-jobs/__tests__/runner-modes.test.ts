import type { BunRunnerOptions, ExecutionMode, RunRecord } from "../lib/index";
import { join } from "node:path";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import { BunRunner, MemoryDriver } from "../lib/index";
import { testNamespace } from "./helpers";

/**
 * The three execution modes, asserted to be interchangeable.
 *
 * A run is the same contract everywhere — same context, same result, same
 * events — and only the blast radius differs. Running one fixture through all
 * three and comparing is what keeps that true as the executors diverge.
 */

const fixture = (name: string) =>
  join(import.meta.dir, "fixtures", "handlers", `${name}.ts`);

const started: BunRunner<any, any>[] = [];

afterEach(async () => {
  await Promise.allSettled(
    started.map((runner) => runner.stop({ force: true })),
  );
  started.length = 0;
});

/** Builds a runner in `mode`, tracked for cleanup. */
function makeRunner(
  mode: ExecutionMode,
  options: Partial<BunRunnerOptions<any>> = {},
): BunRunner<any, any> {
  const defaults = {
    id: `runner-${mode}`,
    namespace: testNamespace(),
    file: fixture("echo"),
    executionMode: mode,
    driver: new MemoryDriver(),
    waitToExit: false,
    logger: noopLogger,
  };

  const runner = new BunRunner({
    ...defaults,
    ...options,
  } as BunRunnerOptions<any>);

  started.push(runner);
  return runner;
}

/** Runs one trigger to completion and reports how it ended. */
async function runOnce(
  runner: BunRunner<any, any>,
  args?: unknown,
): Promise<{ record: RunRecord; result?: unknown; error?: Error }> {
  const settled = new Promise<{
    record: RunRecord;
    result?: unknown;
    error?: Error;
  }>((resolve) => {
    runner.once("finished", (record, result) => resolve({ record, result }));
    runner.once("failed", (record, error) => resolve({ record, error }));
  });

  await runner.trigger({ args });
  return await settled;
}

const MODES: ExecutionMode[] = ["in-process", "worker-thread", "child-process"];

describe.each(MODES)("execution mode: %s", (mode) => {
  it("runs the handler and returns its result", async () => {
    const runner = makeRunner(mode);
    await runner.start();

    const { record, result } = await runOnce(runner, { value: "hello" });

    expect(record.status).toBe("success");
    expect(record.mode).toBe(mode);
    expect(record.pid).toBeGreaterThan(0);
    expect(result).toMatchObject({
      value: "hello",
      runnerId: `runner-${mode}`,
      namespace: runner.namespace,
      mode,
      source: "manual",
    });
  }, 20_000);

  it("reports a throwing handler with its error intact", async () => {
    const runner = makeRunner(mode, { file: fixture("throw") });
    await runner.start();

    const { record, error } = await runOnce(runner);

    expect(record.status).toBe("failed");
    expect(error?.message).toBe("handler blew up");
    // The code crosses the boundary, which is what a caller branches on.
    expect((error as Error & { code?: string }).code).toBe("E_BOOM");
    expect(record.error?.name).toBe("Error");
  }, 20_000);

  it("forwards progress and messages", async () => {
    const runner = makeRunner(mode, { file: fixture("progress") });
    await runner.start();

    const progress: unknown[] = [];
    runner.on("progress", (_record, value) => progress.push(value));

    const { result } = await runOnce(runner, { steps: 2 });

    expect(result).toBe(2);
    expect(progress).toEqual([
      { step: 1, of: 2 },
      { step: 2, of: 2 },
    ]);
  }, 20_000);

  it("rejects a file with no usable default export", async () => {
    const runner = makeRunner(mode, { file: fixture("not-a-handler") });
    await runner.start();

    const { record, error } = await runOnce(runner);

    expect(record.status).toBe("failed");
    expect(error?.name).toBe("InvalidHandlerError");
  }, 20_000);

  it("records the run in history", async () => {
    const runner = makeRunner(mode);
    await runner.start();
    await runOnce(runner, { value: 1 });

    const history = await runner.history();
    expect(history[0]).toMatchObject({ status: "success", mode });
    expect(history[0].durationMs).toBeGreaterThanOrEqual(0);
  }, 20_000);

  it("sets BUN_JOBS_MODE to the run's own mode, and leaves it unset in-process", async () => {
    const runner = makeRunner(mode, { file: fixture("environment") });
    await runner.start();

    const { record, result } = await runOnce(runner);

    // The same word as `RunRecord.mode`: the executor sets the variable from
    // its own `mode`, so the two cannot drift. In-process nothing starts a
    // runtime, so there is nothing to set.
    expect(record.mode).toBe(mode);
    expect((result as { mode: string | null }).mode).toBe(
      mode === "in-process" ? null : mode,
    );
  }, 20_000);
});

describe("child processes", () => {
  it("tells the handler it is a child", async () => {
    const runner = makeRunner("child-process", {
      file: fixture("environment"),
    });
    await runner.start();

    const { result } = await runOnce(runner);

    expect(result).toMatchObject({
      isChild: true,
      marker: "1",
      mode: "child-process",
    });
  }, 20_000);

  it("forwards the child's logger when asked", async () => {
    const runner = makeRunner("child-process", {
      file: fixture("progress"),
      forwardLogs: true,
    });
    await runner.start();

    const logs: { level: string; message: string }[] = [];
    runner.on("log", (_record, level, message) => {
      logs.push({ level, message });
    });

    await runOnce(runner, { steps: 1 });

    expect(logs).toContainEqual({ level: "info", message: "done stepping" });
  }, 20_000);

  it("reports a child that exits without a result", async () => {
    const runner = makeRunner("child-process", { file: fixture("exit") });
    await runner.start();

    const { record, error } = await runOnce(runner);

    expect(record.status).toBe("failed");
    expect(error?.name).toBe("ChildExitError");
    expect(record.exitCode).toBe(3);
  }, 20_000);

  it("passes the driver config through so a child can reach the backend", async () => {
    const runner = makeRunner("child-process", {
      file: fixture("environment"),
      driver: { type: "memory" },
    });
    await runner.start();

    const { result } = await runOnce(runner);
    expect(result).toMatchObject({ driverConfig: { type: "memory" } });
  }, 20_000);
});
