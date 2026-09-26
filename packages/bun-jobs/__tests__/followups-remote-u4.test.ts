import type {
  BunQueueWorkerOptions,
  DriverEvent,
  JobProcessor,
} from "../lib/index";
import { join } from "node:path";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import * as contract from "../lib/api/contract/constants";
import {
  BunQueue,
  BunQueueWorker,
  BunRunner,
  BunRunnerManager,
  ConfigError,
  EXECUTION_MODES,
  MemoryDriver,
  readWorkerConfig,
  readWorkerControl,
  RUNNER_CONFIG_BOUNDS,
  RUNNER_CONFIG_KEYS,
  WorkerController,
  WorkerStateConflictError,
  writeWorkerConfig,
} from "../lib/index";
import { testNamespace, waitFor } from "./helpers";

/**
 * Follow-ups to remote worker control, remote runner configuration and queue
 * job defaults: the library refusing what the management API refuses, a
 * direct runner config change reaching the runner's other owners, the root
 * exports, and a re-enabled repeat series under the stored job defaults.
 */

/** Things to close after each test, whatever it did to them. */
const closers: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  await Promise.allSettled(closers.map(async (close) => await close()));
  closers.length = 0;
});

/** A remotely controllable worker on `mail`, registered for cleanup. */
function makeWorker(
  driver: MemoryDriver,
  ns: string,
  processor: JobProcessor<unknown, unknown> = async () => null,
  options?: Partial<BunQueueWorkerOptions>,
): BunQueueWorker<unknown, unknown> {
  const worker = new BunQueueWorker<unknown, unknown>("mail", processor, {
    namespace: ns,
    driver,
    control: true,
    reportInterval: 200,
    pollInterval: 10,
    waitToExit: false,
    logger: noopLogger,
    ...options,
  });
  closers.push(async () => await worker.close({ force: true }));
  return worker;
}

/** A running worker and a controller over its queue. */
async function fleet(key?: string): Promise<{
  driver: MemoryDriver;
  ns: string;
  worker: BunQueueWorker<unknown, unknown>;
  remote: WorkerController;
}> {
  const driver = new MemoryDriver();
  const ns = testNamespace("fu-remote");
  const worker = makeWorker(
    driver,
    ns,
    undefined,
    key === undefined ? {} : { key },
  );
  void worker.run();
  const remote = new WorkerController({ namespace: ns, queue: "mail", driver });
  await waitFor(async () => (await remote.get(worker.id)) !== null, {
    message: "the worker never registered",
  });
  return { driver, ns, worker, remote };
}

describe("WorkerController.pause() and resume() on a parked worker", () => {
  it("refuses a stopped worker rather than starting it, and writes nothing", async () => {
    const { driver, ns, worker, remote } = await fleet();

    await remote.stop({ id: worker.id });
    await waitFor(
      async () => (await remote.get(worker.id))?.state === "stopped",
      { message: () => `still ${worker.state}` },
    );
    const before = await readWorkerControl(
      driver,
      { ns, queue: "mail" },
      worker.id,
    );

    const refused = await remote
      .pause({ id: worker.id })
      .then(() => null)
      .catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(WorkerStateConflictError);
    const conflict = refused as WorkerStateConflictError;
    expect(conflict.code).toBe("WORKER_STATE_CONFLICT");
    expect(conflict.context).toEqual({
      action: "pause",
      workers: [{ id: worker.id, state: "stopped" }],
    });
    expect(conflict.message).toContain("start it first");

    // Nothing written: the stored instruction is still the stop.
    const after = await readWorkerControl(
      driver,
      { ns, queue: "mail" },
      worker.id,
    );
    expect(after?.seq).toBe(before?.seq);
    expect(after?.value.state).toBe("stopped");

    // And the worker is still parked, not started-then-paused.
    await worker.syncControl();
    expect(worker.state).toBe("stopped");
  });

  it("refuses a whole key fan-out when one replica is parked", async () => {
    const driver = new MemoryDriver();
    const ns = testNamespace("fu-remote");
    const one = makeWorker(driver, ns, undefined, { key: "svc.mail" });
    const two = makeWorker(driver, ns, undefined, { key: "svc.mail" });
    void one.run();
    void two.run();
    const remote = new WorkerController({
      namespace: ns,
      queue: "mail",
      driver,
    });
    await waitFor(async () => (await remote.list()).length === 2, {
      message: "both workers never registered",
    });

    await remote.stop({ id: two.id });
    await waitFor(async () => (await remote.get(two.id))?.state === "stopped", {
      message: () => `still ${two.state}`,
    });

    await expect(remote.pause({ key: "svc.mail" })).rejects.toBeInstanceOf(
      WorkerStateConflictError,
    );
    expect(one.state).toBe("running");

    // The running one is still reachable by its id.
    await remote.pause({ id: one.id });
    await waitFor(() => one.state === "paused", {
      message: () => `still ${one.state}`,
    });
  });

  it("refuses resume() on a stopped worker too, pointing at start()", async () => {
    const { driver, ns, worker, remote } = await fleet();

    await remote.stop({ id: worker.id });
    await waitFor(
      async () => (await remote.get(worker.id))?.state === "stopped",
      { message: () => `still ${worker.state}` },
    );
    const before = await readWorkerControl(
      driver,
      { ns, queue: "mail" },
      worker.id,
    );

    const refused = await remote
      .resume({ id: worker.id })
      .then(() => null)
      .catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(WorkerStateConflictError);
    expect((refused as WorkerStateConflictError).context).toEqual({
      action: "resume",
      workers: [{ id: worker.id, state: "stopped" }],
    });
    expect((refused as WorkerStateConflictError).message).toBe(
      `Worker "${worker.id}" cannot be resumed while it is stopped: use start`,
    );
    const after = await readWorkerControl(
      driver,
      { ns, queue: "mail" },
      worker.id,
    );
    expect(after?.seq).toBe(before?.seq);
    await worker.syncControl();
    expect(worker.state).toBe("stopped");

    // start() is the way back.
    await remote.start({ id: worker.id });
    await waitFor(() => worker.state === "running", {
      message: () => `still ${worker.state}`,
    });
  });

  it("still pauses a running worker, and resumes it", async () => {
    const { worker, remote } = await fleet();

    await remote.pause({ id: worker.id });
    await waitFor(() => worker.state === "paused", {
      message: () => `still ${worker.state}`,
    });
    await remote.resume({ id: worker.id });
    await waitFor(() => worker.state === "running", {
      message: () => `still ${worker.state}`,
    });
  });
});

describe("worker config writes refuse what they used to drop", () => {
  it("throws a ConfigError naming an unknown key, and writes nothing", async () => {
    const { driver, ns, remote } = await fleet("svc.mail");

    const refused = await remote
      .setConfig("svc.mail", {
        concurrency: 4,
        // A misspelling: it used to vanish silently.
        concurency: 4,
      } as Record<string, number>)
      .then(() => null)
      .catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(ConfigError);
    expect((refused as ConfigError).message).toContain('"concurency"');
    expect((refused as ConfigError).context).toMatchObject({
      key: "concurency",
    });
    expect(
      await readWorkerConfig(driver, { ns, queue: "mail" }, "svc.mail"),
    ).toBeNull();
  });

  it("throws a ConfigError naming the key and its bound for a value out of range", async () => {
    const { driver, ns, remote } = await fleet("svc.mail");

    const refused = await remote
      .setConfig("svc.mail", { concurrency: 4, reportInterval: 0 })
      .then(() => null)
      .catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(ConfigError);
    expect((refused as ConfigError).message).toBe(
      "reportInterval must be between 1000 and 600000",
    );
    expect((refused as ConfigError).context).toEqual({
      key: "reportInterval",
      value: 0,
      bound: { min: 1_000, max: 600_000 },
    });
    // Not even the valid half is stored.
    expect(
      await readWorkerConfig(driver, { ns, queue: "mail" }, "svc.mail"),
    ).toBeNull();
  });

  it("refuses a fraction where a whole number is required, in writeWorkerConfig too", async () => {
    const driver = new MemoryDriver();
    const q = { ns: testNamespace("fu-remote"), queue: "mail" };
    await driver.connect();
    await driver.ensureQueue(q);

    await expect(
      writeWorkerConfig(driver, q, "svc.mail", { concurrency: 2.5 }),
    ).rejects.toThrow("concurrency must be a whole number");
    await expect(
      writeWorkerConfig(driver, q, "svc.mail", { concurrency: 1_001 }),
    ).rejects.toThrow("concurrency must be between 1 and 1000");

    // `null` and `undefined` still clear and skip.
    await writeWorkerConfig(driver, q, "svc.mail", { concurrency: 3 });
    const cleared = await writeWorkerConfig(driver, q, "svc.mail", {
      concurrency: null,
      drainDelay: undefined,
    });
    expect(cleared.override.values).toEqual({});
    await driver.close();
  });
});

/** Handler fixtures, resolved from this file. */
const fixture = (name: string) =>
  join(import.meta.dir, "fixtures", "handlers", `${name}.ts`);

describe("BunRunner.updateConfig() / resetConfig() called directly", () => {
  /** Two owners of one runner over one driver, as two processes would be. */
  async function owners(): Promise<{
    driver: MemoryDriver;
    namespace: string;
    first: BunRunner;
    second: BunRunner;
  }> {
    const driver = new MemoryDriver();
    const namespace = testNamespace("fu-runner");
    const build = () =>
      new BunRunner({
        id: "configurable",
        namespace,
        driver,
        file: fixture("append"),
        executionMode: "in-process",
        childDriver: { type: "memory" },
        waitToExit: false,
        // No sync: the other owner can only hear about the change through
        // the `control` event.
        syncInterval: 0,
        control: true,
        logger: noopLogger,
      });
    const first = build();
    const second = build();
    closers.push(
      async () => await first.stop({ force: true }),
      async () => await second.stop({ force: true }),
    );
    await first.start();
    await second.start();
    return { driver, namespace, first, second };
  }

  it("reaches the runner's other owners without waiting for a sync", async () => {
    const { first, second } = await owners();

    await first.updateConfig({ executionMode: "child-process" });
    expect(first.executionMode).toBe("child-process");
    await waitFor(() => second.executionMode === "child-process", {
      message: () => `the other owner is still ${second.executionMode}`,
    });

    await first.resetConfig();
    await waitFor(() => second.executionMode === "in-process", {
      message: () => `the other owner is still ${second.executionMode}`,
    });
  });

  it("publishes one control event per change, also through a local RunnerController", async () => {
    const driver = new MemoryDriver();
    const namespace = testNamespace("fu-runner");
    const manager = new BunRunnerManager({
      namespace,
      driver,
      logger: noopLogger,
    });
    const runner = manager.add({
      id: "configurable",
      file: fixture("append"),
      executionMode: "in-process",
      childDriver: { type: "memory" },
      waitToExit: false,
      syncInterval: 0,
    });
    closers.push(async () => await runner.stop({ force: true }));
    await runner.start();

    const seen: DriverEvent[] = [];
    const unsubscribe = await driver.subscribe(
      namespace,
      "runner",
      "configurable",
      (event) => {
        if (event.type === "control") {
          seen.push(event);
        }
      },
    );
    closers.push(async () => await unsubscribe());

    await runner.updateConfig({ executionMode: "child-process" });
    await waitFor(() => seen.length === 1, {
      message: () => `${seen.length} control events`,
    });
    expect(seen[0]!.payload).toEqual({ action: "config" });

    const remote = await manager.controller("configurable");
    expect(remote.isLocal).toBe(true);
    await remote.resetConfig();

    await waitFor(() => seen.length >= 2, {
      message: () => `${seen.length} control events`,
    });
    // Give a duplicate the chance to arrive before counting.
    await Bun.sleep(30);
    expect(seen).toHaveLength(2);
  });
});

describe("root exports", () => {
  it("exports the runner config constants beside the worker ones", () => {
    expect(EXECUTION_MODES).toBe(contract.EXECUTION_MODES);
    expect(RUNNER_CONFIG_KEYS).toBe(contract.RUNNER_CONFIG_KEYS);
    expect(RUNNER_CONFIG_BOUNDS).toBe(contract.RUNNER_CONFIG_BOUNDS);
    expect([...EXECUTION_MODES]).toEqual([
      "child-process",
      "worker-thread",
      "in-process",
    ]);
  });
});

describe("a re-enabled repeat series", () => {
  it("schedules its next occurrence under the queue's stored job defaults", async () => {
    const driver = new MemoryDriver();
    const queue = new BunQueue("jdef", {
      namespace: testNamespace("fu-repeat"),
      driver,
      logger: noopLogger,
      jobDefaultsRefreshInterval: 0,
    });
    closers.push(async () => await queue.close());

    await queue.add("digest", {}, { repeat: { every: 60_000 }, priority: 2 });
    const [series] = await queue.listRepeatables();
    await queue.setJobDefaults({ attempts: 7, priority: 9, timeout: 900 });

    expect(await queue.disableRepeatable(series!.key)).toBe(true);
    expect(await queue.enableRepeatable(series!.key)).toBe(true);

    const [enabled] = await queue.listRepeatables();
    const occurrence = await driver.getJob(queue.ref, enabled!.nextJobId!);

    expect(occurrence?.opts.attempts).toBe(7);
    expect(occurrence?.maxAttempts).toBe(7);
    expect(occurrence?.opts.timeout).toBe(900);
    // The add's own priority was explicit, so the override leaves it.
    expect(occurrence?.opts.priority).toBe(2);
    expect(occurrence?.priority).toBe(2);
  });
});
