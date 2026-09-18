import type { JobsDriver, QueuedTrigger } from "../lib/index";
import { join } from "node:path";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import {
  BunRunner,
  BunRunnerManager,
  createDriver,
  MemoryDriver,
  runnerKey,
} from "../lib/index";
import { testNamespace } from "./helpers";
import { crossProcessBackends } from "./helpers/backends";

/**
 * A queued trigger records whether it was forced.
 *
 * The pause is checked when a trigger is requested, but the trigger may be
 * drained later and elsewhere, so the record itself has to say `force: true`
 * for a drainer to tell it apart. An unforced record must carry no `force`
 * key at all, so it stays exactly what earlier versions wrote.
 *
 * Every record is read straight from the driver, on every backend the runner
 * suites use: the memory driver, and each cross-process backend (file and
 * sqlite always, the servers when their URL is set).
 */

/** Temp-directory cleanups for the file and sqlite backends. */
const cleanups: (() => Promise<void>)[] = [];

const BACKENDS = await crossProcessBackends({ cleanups });

afterAll(async () => {
  await Promise.allSettled(cleanups.map((cleanup) => cleanup()));
});

/** The runner's id in every test. */
const ID = "reports";

/** The `append` handler fixture. */
const HANDLER = join(import.meta.dir, "fixtures", "handlers", "append.ts");

/** Runners started by a test, stopped afterwards. */
const started: BunRunner<{ ms?: number }, string>[] = [];

/** Namespaces a test wrote, each purged by exact name afterwards. */
const written: { driver: JobsDriver; namespace: string }[] = [];

afterEach(async () => {
  await Promise.allSettled(
    started.map((runner) => runner.stop({ force: true })),
  );
  started.length = 0;

  await Promise.allSettled(
    written.map(({ driver, namespace }) => driver.purge(namespace)),
  );
  written.length = 0;
});

/** A single-mode runner that queues in the driver when it cannot run. */
function makeRunner(
  driver: JobsDriver,
  namespace: string,
): BunRunner<{ ms?: number }, string> {
  const runner = new BunRunner<{ ms?: number }, string>({
    id: ID,
    namespace,
    driver,
    file: HANDLER,
    executionMode: "in-process",
    waitToExit: false,
    syncInterval: 0,
    queueRuns: true,
    logger: noopLogger,
    args: { ms: 5 },
  });
  started.push(runner);
  return runner;
}

/** Pops the next queued trigger, failing the test when there is none. */
async function popTrigger(
  driver: JobsDriver,
  namespace: string,
): Promise<QueuedTrigger> {
  const trigger = await driver.popQueuedTrigger(namespace, runnerKey(ID));
  expect(trigger).not.toBeNull();
  return trigger as QueuedTrigger;
}

/** A forced trigger's record says so. */
function expectForced(trigger: QueuedTrigger): void {
  expect(trigger.force).toBe(true);
}

/** An unforced trigger's record has no `force` key at all, as before. */
function expectUnforced(trigger: QueuedTrigger): void {
  expect(Object.keys(trigger)).not.toContain("force");
}

/** Registers the queued-trigger tests against one driver. */
function forceSuite(connect: () => Promise<JobsDriver>): void {
  let driver: JobsDriver;

  afterAll(async () => {
    await driver?.close();
  });

  /** A fresh namespace on the suite's driver, purged after the test. */
  async function setup(): Promise<{ driver: JobsDriver; namespace: string }> {
    driver ??= await connect();
    const namespace = testNamespace("force");
    written.push({ driver, namespace });
    return { driver, namespace };
  }

  it("BunRunner: records force on a trigger queued because the lock is held elsewhere", async () => {
    const { driver, namespace } = await setup();
    const runner = makeRunner(driver, namespace);
    await runner.start();

    // Another process holds the lock, so every trigger here queues.
    expect(
      await driver.acquireLock(
        namespace,
        runnerKey(ID),
        "elsewhere",
        60_000,
        Date.now(),
      ),
    ).toBe(true);

    expect((await runner.trigger()).outcome).toBe("queued");
    expectUnforced(await popTrigger(driver, namespace));

    await runner.pause();
    expect(await runner.trigger()).toEqual({
      outcome: "skipped",
      reason: "paused",
    });
    expect((await runner.trigger({ force: true })).outcome).toBe("queued");
    expectForced(await popTrigger(driver, namespace));
  });

  it("BunRunner: records force on a trigger queued behind a run in flight", async () => {
    const { driver, namespace } = await setup();
    const runner = makeRunner(driver, namespace);
    await runner.start();

    expect((await runner.trigger({ args: { ms: 1_000 } })).outcome).toBe(
      "started",
    );

    // Popped straight away, so the run's own drain finds nothing to start.
    expect((await runner.trigger()).outcome).toBe("queued");
    expectUnforced(await popTrigger(driver, namespace));

    await runner.pause();
    expect((await runner.trigger({ force: true })).outcome).toBe("queued");
    expectForced(await popTrigger(driver, namespace));
  });

  it("RemoteRunner: records force on a trigger queued remotely", async () => {
    const { driver, namespace } = await setup();
    const owner = new BunRunnerManager({
      namespace,
      driver,
      logger: noopLogger,
    });
    const runner = owner.add<{ ms?: number }, string>({
      id: ID,
      file: HANDLER,
      executionMode: "in-process",
      waitToExit: false,
      syncInterval: 0,
    });
    started.push(runner);
    await runner.start();
    // Stopped, so nothing drains what the remote queues.
    await runner.stop();

    const observer = new BunRunnerManager({
      namespace,
      driver,
      logger: noopLogger,
    });
    const remote = await observer.remote(ID);

    expect((await remote.trigger()).outcome).toBe("queued");
    expectUnforced(await popTrigger(driver, namespace));

    await remote.pause();
    expect(await remote.trigger()).toEqual({
      outcome: "skipped",
      reason: "paused",
    });
    expect((await remote.trigger({ force: true })).outcome).toBe("queued");
    expectForced(await popTrigger(driver, namespace));
    expect((await remote.info()).queuedTriggers).toBe(0);
  });
}

describe("queued trigger force: memory", () => {
  forceSuite(async () => new MemoryDriver());
});

for (const { name, config, available } of BACKENDS) {
  describe.skipIf(!available)(`queued trigger force: ${name}`, () => {
    forceSuite(async () => {
      const driver = createDriver(config);
      await driver.connect();
      return driver;
    });
  });
}
