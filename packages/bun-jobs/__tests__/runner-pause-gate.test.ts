import type { BunRunnerOptions, JobsDriver, QueuedTrigger } from "../lib/index";
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
import { testNamespace, waitFor } from "./helpers";
import { crossProcessBackends } from "./helpers/backends";

/**
 * The pause gate on a runner's queued triggers.
 *
 * While paused, a drain peeks at the head of the queue: a forced head
 * (`force: true`) is popped and run, anything else stays where it is — and so
 * does everything behind it — until `resume()`. Strict FIFO, head only. That
 * holds for the driver's queue (single mode, and remote triggers in parallel
 * mode) and for parallel mode's queue in this process.
 *
 * No test waits on a clock: a held run ends when the test sends it
 * `"release"`, and `settle()` awaits every run's own `done`, which covers the
 * drain that follows it. Every backend the runner suites use is covered: the
 * memory driver, and each cross-process backend (file and sqlite always, the
 * servers when their URL is set).
 */

/** Temp-directory cleanups for the file and sqlite backends. */
const cleanups: (() => Promise<void>)[] = [];

const BACKENDS = await crossProcessBackends({ cleanups });

afterAll(async () => {
  await Promise.allSettled(cleanups.map((cleanup) => cleanup()));
});

/** The runner's id in every test. */
const ID = "gate";

/** The runner's key in the driver. */
const KEY = runnerKey(ID);

/** The `gated` handler fixture. */
const HANDLER = join(import.meta.dir, "fixtures", "handlers", "gated.ts");

/** Arguments the `gated` handler takes. */
interface GateArgs {
  /** Returned as the result, to read run order back from the history. */
  marker?: string;
  /** Hold the run open until it is sent `"release"`. */
  hold?: boolean;
}

/** A runner over the `gated` handler. */
type GateRunner = BunRunner<GateArgs, string>;

/** How long a condition that crosses a backend's event path may take. */
const EVENT_TIMEOUT = 10_000;

/** Runners started by a test, stopped afterwards. */
const started: GateRunner[] = [];

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

/**
 * Every run a runner has started, by its `done` — which settles only once the
 * run's record is written and the drain after it has finished. `activeRuns`
 * alone is not enough: a run leaves it before its record is written.
 */
const runs = new WeakMap<GateRunner, Promise<unknown>[]>();

/** A runner over the `gated` handler that queues when it cannot run. */
function makeRunner(
  driver: JobsDriver,
  namespace: string,
  overrides?: Partial<BunRunnerOptions<GateArgs>>,
): GateRunner {
  const runner = new BunRunner<GateArgs, string>({
    id: ID,
    namespace,
    driver,
    file: HANDLER,
    executionMode: "in-process",
    waitToExit: false,
    syncInterval: 0,
    queueRuns: true,
    logger: noopLogger,
    ...overrides,
  });
  const dones: Promise<unknown>[] = [];
  runs.set(runner, dones);
  // `started` is emitted once the run is in `activeRuns`.
  runner.on("started", (run) => {
    const handle = runner.activeRuns.get(run.runId);
    if (handle) {
      dones.push(handle.done);
    }
  });
  started.push(runner);
  return runner;
}

/**
 * Waits until every run this runner started has settled, following the
 * chain: a run's `done` covers the drain after it, which may start the next.
 */
async function settle(runner: GateRunner): Promise<void> {
  const dones = runs.get(runner) ?? [];
  let seen: number;
  do {
    seen = dones.length;
    await Promise.allSettled(dones);
  } while (dones.length !== seen);
}

/** Starts a run held open until {@link release}, returning its id. */
async function hold(runner: GateRunner): Promise<string> {
  const outcome = await runner.trigger({
    args: { marker: "held", hold: true },
  });
  expect(outcome.outcome).toBe("started");
  return (outcome as { runId: string }).runId;
}

/** Ends a held run and waits for everything its drain started to finish. */
async function release(runner: GateRunner, runId: string): Promise<void> {
  expect(runner.send("release", runId)).toBe(true);
  await settle(runner);
}

/**
 * The markers of the finished runs that came off a queue, oldest first. A
 * finished record is written before the drain that follows it, so after
 * `settle()` every one is there.
 */
async function queuedMarkers(runner: GateRunner): Promise<unknown[]> {
  const history = await runner.history(50);
  return history
    .filter((run) => run.source === "queued" && run.status !== "running")
    .reverse()
    .map((run) => run.result);
}

/** A queued-trigger record as a remote controller, or an older version, writes it. */
function record(marker: string, force?: boolean): QueuedTrigger {
  return {
    id: `${marker}-${crypto.randomUUID()}`,
    args: { marker },
    source: "manual",
    requestedAt: Date.now(),
    requestedBy: "elsewhere",
    ...(force ? { force: true } : {}),
  };
}

/**
 * Registers the pause-gate tests against one driver. `connectPeer` gives
 * another owner its own connection to the same backend, as a second process
 * would have — the memory driver can only share its one instance.
 */
function gateSuite(
  connect: () => Promise<JobsDriver>,
  connectPeer: (driver: JobsDriver) => Promise<JobsDriver>,
): void {
  let driver: JobsDriver;
  /** Peer connections opened by a test, closed with the suite. */
  const peers: JobsDriver[] = [];

  afterAll(async () => {
    await Promise.allSettled(
      peers.filter((peer) => peer !== driver).map((peer) => peer.close()),
    );
    await driver?.close();
  });

  /** A fresh namespace on the suite's driver, purged after the test. */
  async function setup(): Promise<{ driver: JobsDriver; namespace: string }> {
    driver ??= await connect();
    const namespace = testNamespace("gate");
    written.push({ driver, namespace });
    return { driver, namespace };
  }

  /** How many triggers wait in the driver. */
  const count = async (namespace: string) =>
    await driver.countQueuedTriggers(namespace, KEY);

  /** Whether the single-run lock is free. */
  const lockFree = async (namespace: string) =>
    (await driver.getLock(namespace, KEY, Date.now())) === null;

  describe("single mode (the driver's queue)", () => {
    it("leaves an unforced trigger queued while paused, and runs it on resume", async () => {
      const { namespace } = await setup();
      const runner = makeRunner(driver, namespace);
      await runner.start();

      const held = await hold(runner);
      expect((await runner.trigger({ args: { marker: "u1" } })).outcome).toBe(
        "queued",
      );
      await runner.pause();
      await release(runner, held);

      // The held run's drain saw an unforced head: nothing ran, nothing was
      // taken, and the lock went back.
      expect(await queuedMarkers(runner)).toEqual([]);
      expect(await count(namespace)).toBe(1);
      expect(await lockFree(namespace)).toBe(true);

      await runner.resume();
      await settle(runner);

      expect(await queuedMarkers(runner)).toEqual(["u1"]);
      expect(await count(namespace)).toBe(0);
      expect(await lockFree(namespace)).toBe(true);
    });

    it("runs a forced head while paused, and holds the unforced trigger behind it", async () => {
      const { namespace } = await setup();
      const runner = makeRunner(driver, namespace);
      await runner.start();

      const held = await hold(runner);
      // Forced before the pause still records `force: true`.
      expect(
        (await runner.trigger({ force: true, args: { marker: "f1" } })).outcome,
      ).toBe("queued");
      expect((await runner.trigger({ args: { marker: "u1" } })).outcome).toBe(
        "queued",
      );
      await runner.pause();
      await release(runner, held);

      expect(await queuedMarkers(runner)).toEqual(["f1"]);
      expect(await count(namespace)).toBe(1);
      expect(await lockFree(namespace)).toBe(true);

      await runner.resume();
      await settle(runner);

      expect(await queuedMarkers(runner)).toEqual(["f1", "u1"]);
      expect(await count(namespace)).toBe(0);
    });

    it("holds a forced trigger behind an unforced head, then runs both in order on resume", async () => {
      const { namespace } = await setup();
      const runner = makeRunner(driver, namespace);
      await runner.start();

      const held = await hold(runner);
      expect((await runner.trigger({ args: { marker: "u1" } })).outcome).toBe(
        "queued",
      );
      await runner.pause();
      expect(
        (await runner.trigger({ force: true, args: { marker: "f1" } })).outcome,
      ).toBe("queued");
      await release(runner, held);

      // Head only: the forced trigger waits behind the unforced one.
      expect(await queuedMarkers(runner)).toEqual([]);
      expect(await count(namespace)).toBe(2);
      expect((await driver.peekQueuedTrigger(namespace, KEY))?.args).toEqual({
        marker: "u1",
      });
      expect(await lockFree(namespace)).toBe(true);

      await runner.resume();
      await settle(runner);

      expect(await queuedMarkers(runner)).toEqual(["u1", "f1"]);
      expect(await count(namespace)).toBe(0);
    });

    it("leaves a record written before force was recorded for resume, without taking the lock", async () => {
      const { namespace } = await setup();
      // No `force` key at all, exactly as an earlier version wrote it.
      const legacy = record("legacy");
      expect(Object.keys(legacy)).not.toContain("force");
      expect(await driver.pushQueuedTrigger(namespace, KEY, legacy, 10)).toBe(
        true,
      );

      const runner = makeRunner(driver, namespace, { startPaused: true });
      // `start()` drains what waits, and awaits it.
      await runner.start();
      await settle(runner);

      expect(await queuedMarkers(runner)).toEqual([]);
      expect(await count(namespace)).toBe(1);
      expect(await lockFree(namespace)).toBe(true);

      await runner.resume();
      await settle(runner);

      expect(await queuedMarkers(runner)).toEqual(["legacy"]);
      expect(await count(namespace)).toBe(0);
    });
  });

  describe("parallel mode", () => {
    it("the driver's queue: runs a forced head while paused and holds the unforced one behind it", async () => {
      const { namespace } = await setup();
      expect(
        await driver.pushQueuedTrigger(namespace, KEY, record("f1", true), 10),
      ).toBe(true);
      expect(
        await driver.pushQueuedTrigger(namespace, KEY, record("u1"), 10),
      ).toBe(true);

      const runner = makeRunner(driver, namespace, {
        runMode: "parallel",
        maxConcurrency: 2,
        startPaused: true,
      });
      await runner.start();
      await settle(runner);

      // Room for two, but only the forced head may run while paused.
      expect(await queuedMarkers(runner)).toEqual(["f1"]);
      expect(await count(namespace)).toBe(1);

      await runner.resume();
      await settle(runner);

      expect(await queuedMarkers(runner)).toEqual(["f1", "u1"]);
      expect(await count(namespace)).toBe(0);
    });

    it("the local queue: holds an unforced head and the forced trigger behind it, then runs both in order", async () => {
      const { namespace } = await setup();
      const runner = makeRunner(driver, namespace, {
        runMode: "parallel",
        maxConcurrency: 1,
      });
      const dequeued: unknown[] = [];
      runner.on("dequeued", (trigger) => dequeued.push(trigger.args?.marker));
      await runner.start();

      const held = await hold(runner);
      expect((await runner.trigger({ args: { marker: "u1" } })).outcome).toBe(
        "queued",
      );
      await runner.pause();
      expect(
        (await runner.trigger({ force: true, args: { marker: "f1" } })).outcome,
      ).toBe("queued");
      await release(runner, held);

      expect(dequeued).toEqual([]);
      expect(await queuedMarkers(runner)).toEqual([]);

      await runner.resume();
      await settle(runner);

      expect(dequeued).toEqual(["u1", "f1"]);
      expect(await queuedMarkers(runner)).toEqual(["u1", "f1"]);
    });

    it("the local queue: runs a forced head while paused and holds the unforced one behind it", async () => {
      const { namespace } = await setup();
      const runner = makeRunner(driver, namespace, {
        runMode: "parallel",
        maxConcurrency: 1,
      });
      const dequeued: unknown[] = [];
      runner.on("dequeued", (trigger) => dequeued.push(trigger.args?.marker));
      await runner.start();

      const held = await hold(runner);
      expect(
        (await runner.trigger({ force: true, args: { marker: "f1" } })).outcome,
      ).toBe("queued");
      expect((await runner.trigger({ args: { marker: "u1" } })).outcome).toBe(
        "queued",
      );
      await runner.pause();
      await release(runner, held);

      expect(dequeued).toEqual(["f1"]);
      expect(await queuedMarkers(runner)).toEqual(["f1"]);

      await runner.resume();
      await settle(runner);

      expect(dequeued).toEqual(["f1", "u1"]);
      expect(await queuedMarkers(runner)).toEqual(["f1", "u1"]);
    });
    it("several owners racing for a forced head run it exactly once and leave the rest in order", async () => {
      const { namespace } = await setup();
      const forced = [record("f1", true), record("f2", true)];
      const unforced = [record("u1"), record("u2"), record("u3")];
      for (const trigger of [...forced, ...unforced]) {
        expect(
          await driver.pushQueuedTrigger(namespace, KEY, trigger, 10),
        ).toBe(true);
      }

      // Four paused owners of one runner, each on its own connection, all
      // draining at once: `start()` drains what waits, and awaits it. Every
      // one peeks the same forced head and tries to take it.
      const owners: GateRunner[] = [];
      for (let index = 0; index < 4; index++) {
        const peer = index === 0 ? driver : await connectPeer(driver);
        peers.push(peer);
        owners.push(
          makeRunner(peer, namespace, {
            runMode: "parallel",
            maxConcurrency: 4,
            startPaused: true,
          }),
        );
      }
      const dequeued: string[] = [];
      for (const owner of owners) {
        owner.on("dequeued", (trigger) => dequeued.push(trigger.id));
      }

      await Promise.all(owners.map((owner) => owner.start()));
      await Promise.all(owners.map((owner) => settle(owner)));

      // Each forced trigger was taken exactly once, by one owner...
      expect([...dequeued].sort()).toEqual(
        forced.map((trigger) => trigger.id).sort(),
      );
      expect([...(await queuedMarkers(owners[0]!))].sort()).toEqual([
        "f1",
        "f2",
      ]);
      // ...and the unforced ones are all still queued, in their order.
      for (const owner of owners) {
        await owner.stop();
      }
      const left: string[] = [];
      for (
        let trigger = await driver.popQueuedTrigger(namespace, KEY);
        trigger;
        trigger = await driver.popQueuedTrigger(namespace, KEY)
      ) {
        left.push(trigger.id);
      }
      expect(left).toEqual(unforced.map((trigger) => trigger.id));
    });
  });

  describe("remote triggers", () => {
    /** A remote controller for the runner, from a manager that does not own it. */
    async function remoteFor(namespace: string) {
      const observer = new BunRunnerManager({
        namespace,
        driver,
        logger: noopLogger,
      });
      return await observer.remote<GateArgs, string>(ID);
    }

    it("a paused owner drains a forced remote trigger", async () => {
      const { namespace } = await setup();
      const owner = makeRunner(driver, namespace, { remoteControl: true });
      await owner.start();
      const remote = await remoteFor(namespace);

      await remote.pause();
      await waitFor(() => owner.status === "paused", {
        timeout: EVENT_TIMEOUT,
      });

      expect(
        (await remote.trigger({ force: true, args: { marker: "f1" } })).outcome,
      ).toBe("queued");
      await waitFor(async () => (await queuedMarkers(owner)).includes("f1"), {
        timeout: EVENT_TIMEOUT,
        message: "the forced trigger never ran",
      });

      expect(await count(namespace)).toBe(0);
      expect(owner.status).toBe("paused");
    });

    it("a paused owner leaves an unforced remote head, and the forced one behind it, for resume", async () => {
      const { namespace } = await setup();
      // Registered, then stopped, so nothing drains what the remote queues.
      const first = makeRunner(driver, namespace);
      await first.start();
      await first.stop();
      const remote = await remoteFor(namespace);

      expect((await remote.trigger({ args: { marker: "u1" } })).outcome).toBe(
        "queued",
      );
      await remote.pause();
      expect(
        (await remote.trigger({ force: true, args: { marker: "f1" } })).outcome,
      ).toBe("queued");

      // The owner adopts the paused flag on start and drains, awaited.
      const owner = makeRunner(driver, namespace, { remoteControl: true });
      await owner.start();
      await settle(owner);

      expect(owner.status).toBe("paused");
      expect(await queuedMarkers(owner)).toEqual([]);
      expect(await count(namespace)).toBe(2);
      expect(await lockFree(namespace)).toBe(true);

      // A remote resume reaches the owner as a `control` event.
      await remote.resume();
      await waitFor(async () => (await queuedMarkers(owner)).length === 2, {
        timeout: EVENT_TIMEOUT,
        message: async () =>
          `ran ${JSON.stringify(await queuedMarkers(owner))}`,
      });

      expect(await queuedMarkers(owner)).toEqual(["u1", "f1"]);
      expect(await count(namespace)).toBe(0);
    });
  });
}

describe("runner pause gate: memory", () => {
  gateSuite(
    async () => new MemoryDriver(),
    async (driver) => driver,
  );
});

for (const { name, config, available } of BACKENDS) {
  describe.skipIf(!available)(`runner pause gate: ${name}`, () => {
    const connect = async () => {
      const driver = createDriver(config);
      await driver.connect();
      return driver;
    };
    gateSuite(connect, connect);
  });
}
