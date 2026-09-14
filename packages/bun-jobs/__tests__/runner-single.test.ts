import type { BunRunnerOptions } from "../lib/index";
import { join } from "node:path";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import { BunRunner, MemoryDriver } from "../lib/index";
import { testNamespace, waitFor } from "./helpers";

/**
 * Run modes: what happens when a trigger arrives and a run is already going.
 *
 * This is the part that spans processes. A shared driver stands in for two
 * processes here — two `BunRunner` instances with the same id and namespace
 * are exactly what a second process would build — so the lock, the queued
 * triggers and the drain are all exercised for real, without spawning
 * anything.
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

/** Builds a runner sharing `driver`, as a second process would. */
function makeRunner(
  driver: MemoryDriver,
  namespace: string,
  options: Partial<BunRunnerOptions<any>> = {},
): BunRunner<any, any> {
  const defaults = {
    id: "shared-runner",
    namespace,
    file: fixture("sleep"),
    executionMode: "in-process",
    driver,
    waitToExit: false,
    logger: noopLogger,
    args: { ms: 60 },
  };

  const runner = new BunRunner({
    ...defaults,
    ...options,
  } as BunRunnerOptions<any>);

  started.push(runner);
  return runner;
}

describe("BunRunner: single mode", () => {
  it("lets only one instance run at a time", async () => {
    const driver = new MemoryDriver();
    const namespace = testNamespace();

    const first = makeRunner(driver, namespace);
    const second = makeRunner(driver, namespace);
    await first.start();
    await second.start();

    const firstOutcome = await first.trigger();
    const secondOutcome = await second.trigger();

    expect(firstOutcome.outcome).toBe("started");
    // The lock is held elsewhere, and this runner does not queue.
    expect(secondOutcome).toEqual({
      outcome: "skipped",
      reason: "lock-held",
    });
  });

  it("skips a trigger while its own run is in flight", async () => {
    const runner = makeRunner(new MemoryDriver(), testNamespace());
    await runner.start();

    await runner.trigger();
    expect(await runner.trigger()).toEqual({
      outcome: "skipped",
      reason: "busy",
    });
  });

  it("queues the trigger when asked, and the holder drains it", async () => {
    const driver = new MemoryDriver();
    const namespace = testNamespace();

    const holder = makeRunner(driver, namespace, { queueRuns: true });
    const other = makeRunner(driver, namespace, { queueRuns: true });
    await holder.start();
    await other.start();

    const sources: string[] = [];
    holder.on("finished", (record) => sources.push(record.source));

    await holder.trigger();
    // The demand is persisted in the driver, so it survives this process.
    const queued = await other.trigger({ args: { ms: 5 } });
    expect(queued).toMatchObject({ outcome: "queued", position: 1 });

    await waitFor(() => sources.length >= 2, {
      timeout: 3000,
      message: "the lock holder did not drain the queued trigger",
    });

    expect(sources).toEqual(["manual", "queued"]);
    expect((await holder.info()).queuedTriggers).toBe(0);
  });

  it("refuses to queue past maxQueuedRuns", async () => {
    const driver = new MemoryDriver();
    const namespace = testNamespace();

    const holder = makeRunner(driver, namespace, {
      queueRuns: true,
      maxQueuedRuns: 1,
      args: { ms: 400 },
    });
    await holder.start();

    await holder.trigger();
    expect((await holder.trigger()).outcome).toBe("queued");
    expect(await holder.trigger()).toEqual({
      outcome: "skipped",
      reason: "queue-full",
    });
  });

  it("drains queued triggers in order", async () => {
    const driver = new MemoryDriver();
    const namespace = testNamespace();

    const runner = makeRunner(driver, namespace, {
      queueRuns: true,
      file: fixture("echo"),
      args: { value: "first" },
    });
    await runner.start();

    const values: unknown[] = [];
    runner.on("finished", (_record, result) => {
      values.push((result as { value: unknown }).value);
    });

    await runner.trigger();
    await runner.trigger({ args: { value: "second" } });
    await runner.trigger({ args: { value: "third" } });

    await waitFor(() => values.length >= 3, {
      message: "queued triggers were not drained in order",
    });
    expect(values).toEqual(["first", "second", "third"]);
  });

  it("releases the lock once the queue is empty", async () => {
    const driver = new MemoryDriver();
    const namespace = testNamespace();

    const runner = makeRunner(driver, namespace, {
      file: fixture("echo"),
      queueRuns: true,
    });
    await runner.start();

    await runner.trigger();
    await waitFor(async () => !(await runner.info()).isRunning, {
      message: "the lock was never released",
    });

    // A fresh instance — another process — can now take it.
    const next = makeRunner(driver, namespace, { file: fixture("echo") });
    await next.start();
    expect((await next.trigger()).outcome).toBe("started");
  });

  it("reports who holds the lock", async () => {
    const runner = makeRunner(new MemoryDriver(), testNamespace(), {
      args: { ms: 200 },
    });
    await runner.start();
    await runner.trigger();

    const info = await runner.info();
    expect(info.isRunning).toBe(true);
    expect(info.runningOn?.pid).toBe(process.pid);
    expect(info.activeRuns).toHaveLength(1);
    // The run in flight, not the runner's own id.
    expect(info.runningOn?.runId).toBe(info.activeRuns[0]!.runId);
  });
});

describe("BunRunner: parallel mode", () => {
  it("lets runs overlap", async () => {
    const runner = makeRunner(new MemoryDriver(), testNamespace(), {
      runMode: "parallel",
      args: { ms: 80 },
    });
    await runner.start();

    await runner.trigger();
    await runner.trigger();
    await runner.trigger();

    expect(runner.activeRuns.size).toBe(3);
  });

  it("caps concurrency and skips the excess", async () => {
    const runner = makeRunner(new MemoryDriver(), testNamespace(), {
      runMode: "parallel",
      maxConcurrency: 2,
      args: { ms: 200 },
    });
    await runner.start();

    await runner.trigger();
    await runner.trigger();

    expect(await runner.trigger()).toEqual({
      outcome: "skipped",
      reason: "max-concurrency",
    });
    expect(runner.activeRuns.size).toBe(2);
  });

  it("queues past the cap when asked, and drains locally", async () => {
    const runner = makeRunner(new MemoryDriver(), testNamespace(), {
      runMode: "parallel",
      maxConcurrency: 1,
      queueRuns: true,
      file: fixture("echo"),
      args: { value: "a" },
    });
    await runner.start();

    const values: unknown[] = [];
    runner.on("finished", (_record, result) => {
      values.push((result as { value: unknown }).value);
    });

    await runner.trigger();
    const queued = await runner.trigger({ args: { value: "b" } });
    expect(queued).toMatchObject({ outcome: "queued", position: 1 });

    await waitFor(() => values.length >= 2, {
      message: "the local queue was not drained",
    });
    expect(values).toEqual(["a", "b"]);

    // Parallel mode keeps its queue in this process, not in the driver.
    expect((await runner.info()).queuedTriggers).toBe(0);
  });

  it("takes no lock, so another instance runs freely", async () => {
    const driver = new MemoryDriver();
    const namespace = testNamespace();

    const first = makeRunner(driver, namespace, {
      runMode: "parallel",
      args: { ms: 100 },
    });
    const second = makeRunner(driver, namespace, {
      runMode: "parallel",
      args: { ms: 100 },
    });
    await first.start();
    await second.start();

    expect((await first.trigger()).outcome).toBe("started");
    expect((await second.trigger()).outcome).toBe("started");
  });
});

describe("BunRunner: namespaces", () => {
  it("keeps the same runner id in two namespaces independent", async () => {
    const driver = new MemoryDriver();
    const first = makeRunner(driver, testNamespace(), { args: { ms: 100 } });
    const second = makeRunner(driver, testNamespace(), { args: { ms: 100 } });

    await first.start();
    await second.start();

    // Same id, different namespace: two locks, so both run.
    expect((await first.trigger()).outcome).toBe("started");
    expect((await second.trigger()).outcome).toBe("started");

    await first.pause();
    expect((await second.info()).isPaused).toBe(false);
  });
});
