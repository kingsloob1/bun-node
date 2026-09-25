import type { JobsDriver, WorkerEventPayloads } from "../lib/index";
import { afterEach, describe, expect, it } from "bun:test";
import {
  BunQueueWorker,
  FileDriver,
  MemoryDriver,
  WorkerController,
  writeWorkerStop,
} from "../lib/index";
import { makeTmpDir, testNamespace, waitFor } from "./helpers";

/**
 * A worker announces its first start: the first `run()` publishes one `state`
 * event with the state it actually came up in and **no** `previous`, which is
 * how a listener tells a start from a transition. Every later transition
 * carries `previous`, a restart after a stop included.
 *
 * On the memory driver, which delivers in process, and the file driver, which
 * a subscriber polls — the two ways an event reaches a listener.
 */

/** A worker `state` payload, as a subscriber receives it. */
type StatePayload = WorkerEventPayloads["state"];

/** Workers and drivers to close after each test. */
const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup().catch(() => undefined);
  }
});

/** The drivers under test, each fresh per test. */
const DRIVERS: [string, () => Promise<JobsDriver>][] = [
  ["memory", async () => new MemoryDriver()],
  [
    "file",
    async () => {
      const tmp = await makeTmpDir("first-state");
      cleanups.push(tmp.cleanup);
      return new FileDriver({ root: tmp.path, pollInterval: 10 });
    },
  ],
];

/** Subscribes to the queue's worker events and collects every `state` payload. */
async function listen(driver: JobsDriver, ns: string): Promise<StatePayload[]> {
  const seen: StatePayload[] = [];
  await driver.connect();
  const unsubscribe = await driver.subscribe(ns, "worker", "mail", (event) => {
    if (event.type === "state") {
      seen.push(event.payload as StatePayload);
    }
  });
  cleanups.push(async () => await unsubscribe());
  return seen;
}

/** A publishing worker on `mail`, closed after the test. */
function makeWorker(
  driver: JobsDriver,
  ns: string,
  options: { key?: string; stopPersistence?: "key" } = {},
): BunQueueWorker<unknown, unknown> {
  const worker = new BunQueueWorker<unknown, unknown>(
    "mail",
    async () => null,
    {
      namespace: ns,
      driver,
      publish: true,
      control: true,
      reportInterval: 200,
      pollInterval: 10,
      waitToExit: false,
      ...options,
    },
  );
  cleanups.push(async () => await worker.close({ force: true }));
  return worker;
}

/** Waits until `seen` holds `count` events, and a beat more to catch extras. */
async function settle(seen: StatePayload[], count: number): Promise<void> {
  await waitFor(() => seen.length >= count, {
    timeout: 4000,
    message: () => `saw ${JSON.stringify(seen)}`,
  });
  await Bun.sleep(60);
}

/** The transition fields of each event, for a compact comparison. */
function steps(seen: StatePayload[]): string[] {
  return seen.map((event) =>
    "previous" in event
      ? `${String(event.previous)}->${event.state}`
      : `first:${event.state}`,
  );
}

describe.each(DRIVERS)("a worker's first start (%s)", (_name, makeDriver) => {
  it("announces the first run() once, with no previous, and every later change with one", async () => {
    const driver = await makeDriver();
    const ns = testNamespace("first-state");
    const seen = await listen(driver, ns);
    const worker = makeWorker(driver, ns);

    void worker.run();
    await settle(seen, 1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      worker: worker.id,
      key: worker.key,
      state: "running",
    });
    expect(Object.hasOwn(seen[0]!, "previous")).toBe(false);

    // A second run() joins the first: nothing is announced again.
    void worker.run();
    await Bun.sleep(60);
    expect(seen).toHaveLength(1);

    await worker.pause();
    worker.resume();
    await worker.stop();
    worker.start();
    await settle(seen, 6);

    // Worker events are published without waiting for each other, so a
    // backend that appends them independently (the file driver, under load)
    // may deliver the later ones out of order: the transitions are compared
    // as a set, after the first start that precedes them all.
    const [firstStep, ...later] = steps(seen);
    expect(firstStep).toBe("first:running");
    expect(later.sort()).toEqual(
      [
        "running->paused",
        "paused->running",
        "running->stopping",
        "stopping->stopped",
        // A restart after a stop is a transition, not a first start.
        "stopped->running",
      ].sort(),
    );
    expect(seen.filter((event) => !("previous" in event))).toHaveLength(1);
  });

  it("announces a worker paused before run() as paused, and nothing before run()", async () => {
    const driver = await makeDriver();
    const ns = testNamespace("first-state");
    const seen = await listen(driver, ns);
    const worker = makeWorker(driver, ns);

    await worker.pause();
    await Bun.sleep(80);
    expect(seen).toEqual([]);

    void worker.run();
    await settle(seen, 1);
    expect(steps(seen)).toEqual(["first:paused"]);

    worker.resume();
    await settle(seen, 2);
    expect(steps(seen)).toEqual(["first:paused", "paused->running"]);
  });
});

describe("a worker's first start, stopped against its key", () => {
  it("announces stopped, with the reason and no previous", async () => {
    const driver = new MemoryDriver();
    const ns = testNamespace("first-state");
    const seen = await listen(driver, ns);
    await writeWorkerStop(driver, { ns, queue: "mail" }, "svc.mail", true);

    const worker = makeWorker(driver, ns, {
      key: "svc.mail",
      stopPersistence: "key",
    });
    void worker.run();
    await settle(seen, 1);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      state: "stopped",
      reason: "stopped persistently",
    });
    expect(Object.hasOwn(seen[0]!, "previous")).toBe(false);

    // Started remotely, it is a transition.
    const remote = new WorkerController({
      namespace: ns,
      queue: "mail",
      driver,
    });
    await waitFor(async () => (await remote.list()).length > 0, {
      message: "never registered",
    });
    await remote.start({ id: worker.id });
    await settle(seen, 2);
    expect(steps(seen)).toEqual(["first:stopped", "stopped->running"]);
  });
});
