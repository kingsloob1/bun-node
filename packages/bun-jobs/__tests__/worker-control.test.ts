import type {
  BunQueueWorkerOptions,
  JobProcessor,
  WorkerInfo,
} from "../lib/index";
import { createDeferred, createTestLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import {
  BunJobs,
  BunQueue,
  BunQueueWorker,
  deriveWorkerKey,
  listWorkerRecords,
  MemoryDriver,
  readWorkerConfig,
  readWorkerStop,
  RemoteWorker,
  writeWorkerConfig,
  writeWorkerControl,
  writeWorkerStop,
} from "../lib/index";
import { testNamespace, waitFor } from "./helpers";

/**
 * Remote worker control: a worker's two identities, the states it moves
 * between, and what a controller in another process can change about it while
 * it runs.
 *
 * The memory driver throughout, because every one of these behaviours is
 * above the driver — the entries are ordinary queue state, and the per-driver
 * half is asserted in the driver contract.
 */

/** Workers to close after each test, whatever it did to them. */
const open: BunQueueWorker<any, any>[] = [];
/** Contexts to close after each test. */
const contexts: BunJobs<any, any>[] = [];

afterEach(async () => {
  await Promise.allSettled(
    open.map(async (worker) => await worker.close({ force: true })),
  );
  open.length = 0;
  await Promise.allSettled(contexts.map(async (jobs) => await jobs.close()));
  contexts.length = 0;
});

/** A worker on a shared driver, registered for cleanup. */
function makeWorker(
  driver: MemoryDriver,
  ns: string,
  processor: JobProcessor<unknown, unknown>,
  options?: Partial<BunQueueWorkerOptions>,
): BunQueueWorker<unknown, unknown> {
  const worker = new BunQueueWorker<unknown, unknown>("mail", processor, {
    namespace: ns,
    driver,
    remoteControl: true,
    reportInterval: 200,
    pollInterval: 10,
    waitToExit: false,
    ...options,
  });
  open.push(worker);
  return worker;
}

/** This worker's heartbeat record, once it has written one. */
async function record(
  driver: MemoryDriver,
  ns: string,
  id: string,
): Promise<WorkerInfo> {
  const found = (
    await listWorkerRecords(driver, { ns, queue: "mail" }, Date.now())
  ).find((worker) => worker.id === id);

  if (!found) {
    throw new Error(`no record for ${id}`);
  }

  return found;
}

describe("worker identity", () => {
  it("derives a stable key from the service, queue, name and ordinal", () => {
    expect(deriveWorkerKey({ queue: "mail" })).toBe("mail");
    expect(deriveWorkerKey({ service: "billing", queue: "mail" })).toBe(
      "billing.mail",
    );
    expect(
      deriveWorkerKey({ service: "billing", queue: "mail", name: "bulk" }),
    ).toBe("billing.mail.bulk");
    // The first worker on a queue keeps the plain key, so the common case is
    // not disturbed by a second one appearing later.
    expect(deriveWorkerKey({ queue: "mail", ordinal: 1 })).toBe("mail");
    expect(deriveWorkerKey({ queue: "mail", ordinal: 2 })).toBe("mail.2");
  });

  it("gives each incarnation its own id while the key stays put", () => {
    const driver = new MemoryDriver();
    const ns = testNamespace("identity");

    const worker = makeWorker(driver, ns, async () => null, {
      service: "billing",
    });

    expect(worker.key).toBe("billing.mail");
    expect(worker.id.startsWith("billing.mail.")).toBe(true);
    expect(worker.id).not.toBe(worker.key);
    expect(worker.processStartedAt).toBeGreaterThan(0);
  });

  it("takes an explicit id as the key, so a caller with stable ids gets per-id overrides", () => {
    const driver = new MemoryDriver();
    const worker = makeWorker(
      driver,
      testNamespace("identity"),
      async () => null,
      {
        id: "mail-0",
      },
    );

    expect(worker.id).toBe("mail-0");
    expect(worker.key).toBe("mail-0");
  });

  it("gives the second worker a context builds on one queue its own key", () => {
    const jobs = new BunJobs({
      namespace: testNamespace("ordinals"),
      driver: new MemoryDriver(),
      service: "billing",
    });
    contexts.push(jobs);

    const first = jobs.worker("mail", async () => null);
    const second = jobs.worker("mail", async () => null);

    expect(first.key).toBe("billing.mail");
    expect(second.key).toBe("billing.mail.2");
  });
});

describe("worker reporting", () => {
  it("reports its key, service, state, version, config and control", async () => {
    const driver = new MemoryDriver();
    const ns = testNamespace("report");
    const worker = makeWorker(driver, ns, async () => null, {
      service: "billing",
      concurrency: 3,
    });

    void worker.run();
    await waitFor(
      async () =>
        (await listWorkerRecords(driver, { ns, queue: "mail" }, Date.now()))
          .length > 0,
      { message: "the worker never registered" },
    );

    const info = await record(driver, ns, worker.id);
    expect(info.key).toBe("billing.mail");
    expect(info.service).toBe("billing");
    expect(info.state).toBe("running");
    expect(info.processStartedAt).toBe(worker.processStartedAt);
    expect(info.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(info.config?.effective.concurrency).toBe(3);
    expect(info.config?.code.concurrency).toBe(3);
    expect(info.config?.overridden).toEqual([]);
    // `heartbeatInterval` was not given, so it is a third of `lockDuration`.
    expect(info.config?.derived).toEqual(["heartbeatInterval"]);
    expect(info.control?.enabled).toBe(true);
    expect(info.control?.mode).toBe("subscribe");
    expect(info.control?.stopPersistence).toBe("process");
  });

  it("says so when two live workers share an id", async () => {
    const driver = new MemoryDriver();
    const ns = testNamespace("duplicate");
    const { logger, events } = createTestLogger();

    // A record left by a worker on another host, under the very same id.
    await driver.connect();
    await driver.ensureQueue({ ns, queue: "mail" });
    const now = Date.now();
    await driver.registerWorker(
      { ns, queue: "mail" },
      {
        id: "mail-0",
        queue: "mail",
        host: "another-host",
        pid: 4321,
        concurrency: 1,
        active: 0,
        paused: false,
        startedAt: now,
        heartbeatAt: now,
        expiresAt: now + 60_000,
      },
    );

    const worker = makeWorker(driver, ns, async () => null, {
      id: "mail-0",
      logger,
    });
    void worker.run();

    await waitFor(
      () =>
        events.some(
          (event) =>
            event.level === "error" &&
            String(event.message).includes("another live worker"),
        ),
      { message: () => `no duplicate-id error; got ${JSON.stringify(events)}` },
    );
  });
});

describe("stop and start", () => {
  it("parks without resolving run(), and keeps heartbeating", async () => {
    const driver = new MemoryDriver();
    const ns = testNamespace("stop");
    const worker = makeWorker(driver, ns, async () => null);

    let resolved = false;
    void worker.run().then(() => {
      resolved = true;
    });
    await waitFor(() => worker.isRunning, { message: "never started" });

    await worker.stop();

    expect(worker.state).toBe("stopped");
    expect(worker.isStopped()).toBe(true);
    // The supervisor pattern is `await worker.run()`; resolving it here would
    // make a stop look like a shutdown and the process would exit.
    expect(resolved).toBe(false);

    const before = (await record(driver, ns, worker.id)).heartbeatAt;
    await waitFor(
      async () => (await record(driver, ns, worker.id)).heartbeatAt > before,
      {
        message:
          "a stopped worker stopped reporting, so nothing could reach it",
      },
    );
    expect((await record(driver, ns, worker.id)).state).toBe("stopped");
  });

  it("claims nothing while parked, and claims again once started", async () => {
    const driver = new MemoryDriver();
    const ns = testNamespace("stop-claim");
    const ran: unknown[] = [];
    const worker = makeWorker(driver, ns, async (job) => {
      ran.push(job.data);
      return null;
    });
    const queue = new BunQueue<unknown, unknown>("mail", {
      namespace: ns,
      driver,
    });

    void worker.run();
    await waitFor(() => worker.isRunning, { message: "never started" });
    await worker.stop();

    await queue.add("one", {});
    await Bun.sleep(80);
    expect(ran).toEqual([]);

    worker.start();
    await waitFor(() => ran.length === 1, {
      message: "a started worker did not go back to claiming",
    });
    await queue.close();
  });

  it("lets a start call off a stop that is still draining", async () => {
    const driver = new MemoryDriver();
    const ns = testNamespace("stop-cancel");
    const holding = createDeferred<void>();
    const started = createDeferred<void>();

    const worker = makeWorker(driver, ns, async () => {
      started.resolve();
      await holding.promise;
      return null;
    });
    const queue = new BunQueue<unknown, unknown>("mail", {
      namespace: ns,
      driver,
    });

    void worker.run();
    await queue.add("slow", {});
    await started.promise;

    const stopping = worker.stop();
    await waitFor(() => worker.state === "stopping", {
      message: "the stop never began draining",
    });

    worker.start();
    await stopping;
    holding.resolve();

    // The stop lost the race, so the worker is running rather than parked —
    // and it never had to abandon the job it was holding.
    expect(worker.state).toBe("running");
    expect(worker.isStopped()).toBe(false);
    await queue.close();
  });
});

describe("remote control", () => {
  /** A context, its worker and a controller over the same driver. */
  async function makeFleet(options?: Partial<BunQueueWorkerOptions>) {
    const driver = new MemoryDriver();
    const ns = testNamespace("remote");
    const worker = makeWorker(driver, ns, async () => null, options);
    void worker.run();
    await waitFor(() => worker.isRunning, { message: "never started" });

    const remote = new RemoteWorker({ namespace: ns, queue: "mail", driver });
    // The controller reads the registry, so wait until the worker is in it.
    await waitFor(async () => (await remote.list()).length > 0, {
      message: "the worker never registered",
    });

    return { driver, ns, worker, remote };
  }

  it("pauses, resumes, stops and starts a worker by its id", async () => {
    const { worker, remote } = await makeFleet();

    await remote.pause({ id: worker.id });
    await waitFor(() => worker.state === "paused", {
      message: () => `still ${worker.state}`,
    });

    await remote.resume({ id: worker.id });
    await waitFor(() => worker.state === "running", {
      message: () => `still ${worker.state}`,
    });

    await remote.stop({ id: worker.id });
    await waitFor(() => worker.state === "stopped", {
      message: () => `still ${worker.state}`,
    });

    await remote.start({ id: worker.id });
    await waitFor(() => worker.state === "running", {
      message: () => `still ${worker.state}`,
    });
  });

  it("reaches every live worker carrying one stable key", async () => {
    const driver = new MemoryDriver();
    const ns = testNamespace("by-key");
    const one = makeWorker(driver, ns, async () => null, { key: "svc.mail" });
    const two = makeWorker(driver, ns, async () => null, { key: "svc.mail" });
    void one.run();
    void two.run();

    const remote = new RemoteWorker({ namespace: ns, queue: "mail", driver });
    await waitFor(async () => (await remote.list()).length === 2, {
      message: "both workers never registered",
    });

    const result = await remote.pause({ key: "svc.mail" });
    expect(result.instances).toHaveLength(2);

    await waitFor(() => one.state === "paused" && two.state === "paused", {
      message: "an instruction by key did not reach every replica",
    });
  });

  it("ignores an instruction written to the process it replaced, and clears it", async () => {
    const driver = new MemoryDriver();
    const ns = testNamespace("stale");
    const worker = makeWorker(driver, ns, async () => null, { id: "mail-0" });

    // Written against a different `processStartedAt`: the id is stable, so
    // only the incarnation tells the two apart.
    await driver.connect();
    await driver.ensureQueue({ ns, queue: "mail" });
    await writeWorkerControl(
      driver,
      { ns, queue: "mail" },
      {
        id: "mail-0",
        key: "mail-0",
        incarnation: worker.processStartedAt - 5_000,
        state: "stopped",
      },
    );

    void worker.run();
    await waitFor(() => worker.isRunning, { message: "never started" });
    await worker.syncControl();

    // A deploy must come back running, never silently stopped by yesterday's
    // instruction.
    expect(worker.state).toBe("running");
    const { readWorkerControl } = await import("../lib/index");
    expect(
      await readWorkerControl(driver, { ns, queue: "mail" }, "mail-0"),
    ).toBeNull();
  });
});

describe("configuration, applied in place", () => {
  it("applies every setting to a running worker without a restart", async () => {
    const driver = new MemoryDriver();
    const ns = testNamespace("config");
    const worker = makeWorker(driver, ns, async () => null, {
      concurrency: 1,
      lockDuration: 30_000,
      stalledInterval: 30_000,
    });
    void worker.run();
    await waitFor(() => worker.isRunning, { message: "never started" });

    await writeWorkerConfig(driver, { ns, queue: "mail" }, worker.key, {
      concurrency: 7,
      pollInterval: 45,
      maxBlock: 1_234,
      lockDuration: 12_000,
      heartbeatInterval: 3_000,
      stalledInterval: 5_000,
      maxStalledCount: 4,
      reportInterval: 1_500,
      drainDelay: 900,
    });
    await worker.syncControl();

    expect(worker.config.effective).toEqual({
      concurrency: 7,
      pollInterval: 45,
      maxBlock: 1_234,
      lockDuration: 12_000,
      heartbeatInterval: 3_000,
      stalledInterval: 5_000,
      maxStalledCount: 4,
      reportInterval: 1_500,
      drainDelay: 900,
    });
    expect(worker.concurrency).toBe(7);
    expect(worker.pollInterval).toBe(45);
    expect(worker.maxBlock).toBe(1_234);
    expect(worker.config.overridden).toHaveLength(9);
    // The worker never left the loop, so nothing was drained and nothing
    // stopped claiming.
    expect(worker.state).toBe("running");
    expect(worker.isRunning).toBe(true);
  });

  it("renews an in-flight job's lock immediately at a shortened duration", async () => {
    const driver = new MemoryDriver();
    const ns = testNamespace("relock");
    const holding = createDeferred<void>();
    const started = createDeferred<void>();
    const extensions: number[] = [];

    const extend = driver.extendJobLock.bind(driver);
    driver.extendJobLock = async (q, id, token, ms, now) => {
      extensions.push(ms);
      return await extend(q, id, token, ms, now);
    };

    const worker = makeWorker(
      driver,
      ns,
      async () => {
        started.resolve();
        await holding.promise;
        return null;
      },
      { lockDuration: 60_000, heartbeatInterval: 20_000 },
    );
    const queue = new BunQueue<unknown, unknown>("mail", {
      namespace: ns,
      driver,
    });

    void worker.run();
    await queue.add("slow", {});
    await started.promise;
    extensions.length = 0;

    await writeWorkerConfig(driver, { ns, queue: "mail" }, worker.key, {
      lockDuration: 2_000,
      heartbeatInterval: 500,
    });
    await worker.syncControl();

    // Without the immediate renewal the lock would still expire at the old
    // duration's mark while the sweep worked to the new one, and the job
    // would be recovered as stalled and run twice.
    await waitFor(() => extensions.includes(2_000), {
      message: () => `no renewal at the new duration; saw ${extensions.join()}`,
    });

    holding.resolve();
    await queue.close();
  });

  it("drops a field it cannot accept, keeps the rest, and says why", async () => {
    const driver = new MemoryDriver();
    const ns = testNamespace("refusal");
    const worker = makeWorker(driver, ns, async () => null, {
      lockDuration: 30_000,
      heartbeatInterval: 1_000,
    });
    void worker.run();
    await waitFor(() => worker.isRunning, { message: "never started" });

    // A renewal slower than half the lock would let a running job's lock
    // lapse; `concurrency` beside it is perfectly good and must still land.
    await writeWorkerConfig(driver, { ns, queue: "mail" }, worker.key, {
      heartbeatInterval: 20_000,
      lockDuration: 30_000,
      concurrency: 6,
    });
    await worker.syncControl();

    expect(worker.config.effective.heartbeatInterval).toBe(1_000);
    expect(worker.config.effective.concurrency).toBe(6);
    expect(worker.control.lastError?.action).toBe("config");
    expect(worker.control.lastError?.message).toContain("heartbeatInterval");
    // And it never refuses to run over it.
    expect(worker.state).toBe("running");
  });

  it("restores the code's value when an override is reset", async () => {
    const driver = new MemoryDriver();
    const ns = testNamespace("reset");
    const worker = makeWorker(driver, ns, async () => null, { concurrency: 2 });
    void worker.run();
    await waitFor(() => worker.isRunning, { message: "never started" });

    await writeWorkerConfig(driver, { ns, queue: "mail" }, worker.key, {
      concurrency: 9,
    });
    await worker.syncControl();
    expect(worker.concurrency).toBe(9);

    await writeWorkerConfig(
      driver,
      { ns, queue: "mail" },
      worker.key,
      {},
      {
        replace: true,
      },
    );
    await worker.syncControl();

    expect(worker.concurrency).toBe(2);
    expect(worker.config.overridden).toEqual([]);
  });

  it("lets a local set change the code value while an override shadows it", async () => {
    const driver = new MemoryDriver();
    const ns = testNamespace("shadow");
    const { logger, events } = createTestLogger();
    const worker = makeWorker(driver, ns, async () => null, {
      concurrency: 2,
      logger,
    });
    void worker.run();
    await waitFor(() => worker.isRunning, { message: "never started" });

    await writeWorkerConfig(driver, { ns, queue: "mail" }, worker.key, {
      concurrency: 9,
    });
    await worker.syncControl();

    worker.concurrency = 4;

    // The override wins — that is what an override is — but the call is not
    // lost: it changed what the code asks for, and it said so.
    expect(worker.concurrency).toBe(9);
    expect(worker.config.code.concurrency).toBe(4);
    expect(
      events.some(
        (event) =>
          event.level === "warn" &&
          String(event.message).includes("stored override"),
      ),
    ).toBe(true);

    await writeWorkerConfig(driver, { ns, queue: "mail" }, worker.key, {
      concurrency: null,
    });
    await worker.syncControl();
    expect(worker.concurrency).toBe(4);
  });

  it("gives processEvery the same treatment on the registry worker", async () => {
    const driver = new MemoryDriver();
    const jobs = new BunJobs({
      namespace: testNamespace("process-every"),
      driver,
      service: "billing",
    });
    contexts.push(jobs);
    jobs.define("work", async () => null);

    const worker = await jobs.start({ reportInterval: 200, pollInterval: 50 });
    await waitFor(() => worker.isRunning, { message: "never started" });

    await writeWorkerConfig(
      driver,
      { ns: jobs.namespace, queue: "jobs" },
      worker.key,
      { pollInterval: 25 },
    );
    await worker.syncControl();

    jobs.processEvery(500);

    expect(worker.pollInterval).toBe(25);
    expect(worker.config.code.pollInterval).toBe(500);
  });
});

describe("how long a stop lasts", () => {
  it("comes back running after a restart by default", async () => {
    const driver = new MemoryDriver();
    const ns = testNamespace("persist-process");
    const first = makeWorker(driver, ns, async () => null, { key: "svc.mail" });
    void first.run();
    await waitFor(() => first.isRunning, { message: "never started" });

    const remote = new RemoteWorker({ namespace: ns, queue: "mail", driver });
    await waitFor(async () => (await remote.list()).length > 0, {
      message: "never registered",
    });
    await remote.stop({ id: first.id });
    await waitFor(() => first.state === "stopped", {
      message: () => `still ${first.state}`,
    });
    await first.close();

    // A new incarnation of the same worker: a deploy must not come back with
    // every worker silently stopped.
    const second = makeWorker(driver, ns, async () => null, {
      key: "svc.mail",
    });
    void second.run();
    await waitFor(() => second.isRunning, { message: "never restarted" });
    await second.syncControl();

    expect(second.state).toBe("running");
    expect(
      await readWorkerStop(driver, { ns, queue: "mail" }, "svc.mail"),
    ).toBeNull();
  });

  it('comes back stopped with stopPersistence: "key"', async () => {
    const driver = new MemoryDriver();
    const ns = testNamespace("persist-key");
    const first = makeWorker(driver, ns, async () => null, {
      key: "svc.mail",
      stopPersistence: "key",
    });
    void first.run();
    await waitFor(() => first.isRunning, { message: "never started" });

    const remote = new RemoteWorker({ namespace: ns, queue: "mail", driver });
    await waitFor(async () => (await remote.list()).length > 0, {
      message: "never registered",
    });
    expect((await remote.list())[0]?.control?.stopPersistence).toBe("key");

    await remote.stop({ id: first.id });
    await waitFor(
      async () =>
        (await readWorkerStop(driver, { ns, queue: "mail" }, "svc.mail")) !==
        null,
      { message: "the stop was not recorded against the key" },
    );
    await first.close();

    const second = makeWorker(driver, ns, async () => null, {
      key: "svc.mail",
      stopPersistence: "key",
    });
    void second.run();

    await waitFor(() => second.state === "stopped", {
      message: () => `a persistently stopped worker came back ${second.state}`,
    });

    // And starting it clears the record, so it stays started.
    const controller = new RemoteWorker({
      namespace: ns,
      queue: "mail",
      driver,
    });
    await waitFor(async () => (await controller.list()).length > 0, {
      message: "never registered",
    });
    await controller.start({ id: second.id });
    await waitFor(
      async () =>
        second.state === "running" &&
        (await readWorkerStop(driver, { ns, queue: "mail" }, "svc.mail")) ===
          null,
      { message: () => `still ${second.state}` },
    );
  });

  it("only honours a per-instruction persistence when the worker allows it", async () => {
    const driver = new MemoryDriver();
    const ns = testNamespace("persist-override");
    const worker = makeWorker(driver, ns, async () => null, {
      key: "svc.mail",
      stopPersistence: "process",
    });
    void worker.run();
    await waitFor(() => worker.isRunning, { message: "never started" });

    const remote = new RemoteWorker({ namespace: ns, queue: "mail", driver });
    await waitFor(async () => (await remote.list()).length > 0, {
      message: "never registered",
    });
    expect((await remote.list())[0]?.control?.stopPersistenceOverridable).toBe(
      false,
    );

    await remote.stop({ id: worker.id }, { persist: "key" });
    await waitFor(() => worker.state === "stopped", {
      message: () => `still ${worker.state}`,
    });

    // The process, not the caller, decides whether a stop outlives it.
    expect(
      await readWorkerStop(driver, { ns, queue: "mail" }, "svc.mail"),
    ).toBeNull();
  });
});

describe("delivery", () => {
  it("polls rather than subscribing on a driver that cannot push", async () => {
    const driver = new MemoryDriver();
    const ns = testNamespace("poll");
    const worker = makeWorker(driver, ns, async () => null, {
      remoteControl: { subscribe: false, interval: 100 },
    });
    void worker.run();
    await waitFor(() => worker.isRunning, { message: "never started" });

    expect(worker.control.mode).toBe("poll");

    // No event is published at all here: only the control poll can carry it.
    await writeWorkerConfig(driver, { ns, queue: "mail" }, worker.key, {
      concurrency: 5,
    });

    await waitFor(() => worker.concurrency === 5, {
      message: "the control poll never picked the override up",
    });
  });

  it("converges through the heartbeat when nothing else does", async () => {
    const driver = new MemoryDriver();
    const ns = testNamespace("fallback");
    const worker = makeWorker(driver, ns, async () => null, {
      // Neither a subscription nor a control poll: the report is all there is.
      remoteControl: { subscribe: false, interval: 3_600_000 },
      reportInterval: 1_000,
    });
    void worker.run();
    await waitFor(() => worker.isRunning, { message: "never started" });

    await writeWorkerConfig(driver, { ns, queue: "mail" }, worker.key, {
      concurrency: 6,
    });

    await waitFor(() => worker.concurrency === 6, {
      timeout: 4_000,
      message: "the heartbeat fallback never re-read the override",
    });
  });

  it("does not listen at all when remote control is off", async () => {
    const driver = new MemoryDriver();
    const ns = testNamespace("off");
    const worker = makeWorker(driver, ns, async () => null, {
      remoteControl: false,
      concurrency: 2,
    });
    void worker.run();
    await waitFor(() => worker.isRunning, { message: "never started" });

    await writeWorkerConfig(driver, { ns, queue: "mail" }, worker.key, {
      concurrency: 5,
    });
    await worker.syncControl();
    await Bun.sleep(50);

    expect(worker.concurrency).toBe(2);
    expect(worker.control.enabled).toBe(false);
  });

  it("publishes state and config events for a worker that publishes", async () => {
    const driver = new MemoryDriver();
    const ns = testNamespace("events");
    const seen: string[] = [];
    await driver.connect();
    const record = (event: { type: string; payload: unknown }): number =>
      seen.push(`${event.type}:${JSON.stringify(event.payload)}`);
    const unsubscribe = await driver.subscribe(ns, "worker", "mail", record);

    const worker = makeWorker(driver, ns, async () => null, { publish: true });
    void worker.run();
    await waitFor(() => worker.isRunning, { message: "never started" });

    await worker.pause();
    await waitFor(() => seen.some((line) => line.startsWith("state:")), {
      message: "no state event",
    });
    expect(seen.some((line) => line.includes('"state":"paused"'))).toBe(true);

    await writeWorkerConfig(driver, { ns, queue: "mail" }, worker.key, {
      concurrency: 3,
    });
    await worker.syncControl();
    await waitFor(() => seen.some((line) => line.startsWith("config:")), {
      message: "no config event",
    });

    await unsubscribe();
  });
});

describe("the controller's own reads", () => {
  it("lists overrides, and reports who has applied each", async () => {
    const driver = new MemoryDriver();
    const ns = testNamespace("controller");
    const worker = makeWorker(driver, ns, async () => null, {
      key: "svc.mail",
    });
    void worker.run();

    const remote = new RemoteWorker({ namespace: ns, queue: "mail", driver });
    await waitFor(async () => (await remote.list()).length > 0, {
      message: "never registered",
    });

    const written = await remote.setConfig("svc.mail", { concurrency: 5 });
    expect(written.contended).toBe(false);
    expect(written.values).toEqual({ concurrency: 5 });

    await waitFor(() => worker.concurrency === 5, {
      message: "the worker never adopted it",
    });
    // Its report has to land before the controller can see it applied.
    await waitFor(
      async () =>
        (await remote.list()).every(
          (live) => (live.control?.configSeq ?? 0) >= written.seq,
        ),
      { message: "the controller never saw the override applied" },
    );
    expect(
      (await remote.setConfig("svc.mail", { concurrency: 5 })).instances,
    ).toHaveLength(1);

    expect((await remote.listConfigs()).map((entry) => entry.key)).toEqual([
      "svc.mail",
    ]);

    const reset = await remote.resetConfig("svc.mail");
    expect(reset.values).toEqual({});
    await waitFor(() => worker.concurrency === 1, {
      message: "the reset never reached the worker",
    });
  });

  it("refuses a write whose expectedSeq has moved on", async () => {
    const driver = new MemoryDriver();
    const ns = testNamespace("contended");
    const remote = new RemoteWorker({ namespace: ns, queue: "mail", driver });
    await driver.connect();
    await driver.ensureQueue({ ns, queue: "mail" });

    const first = await remote.setConfig("svc.mail", { concurrency: 2 });
    await remote.setConfig("svc.mail", { concurrency: 3 });

    const stale = await remote.setConfig(
      "svc.mail",
      { concurrency: 4 },
      { expectedSeq: first.seq },
    );

    expect(stale.contended).toBe(true);
    const after = await readWorkerConfig(
      driver,
      { ns, queue: "mail" },
      "svc.mail",
    );
    expect(after?.value.values).toEqual({ concurrency: 3 });
  });

  it("reaches a worker in this process without waiting for a poll", async () => {
    const driver = new MemoryDriver();
    const jobs = new BunJobs({
      namespace: testNamespace("local"),
      driver,
      service: "billing",
    });
    contexts.push(jobs);

    const worker = jobs.worker("mail", async () => null, {
      reportInterval: 200,
      pollInterval: 10,
      waitToExit: false,
      // Neither delivery path: only the controller's direct nudge can carry it.
      remoteControl: { subscribe: false, interval: 3_600_000 },
    });
    void worker.run();
    await waitFor(() => worker.isRunning, { message: "never started" });

    const remote = jobs.workers.remote("mail");
    await waitFor(async () => (await remote.list()).length > 0, {
      message: "never registered",
    });

    await remote.pause({ id: worker.id });
    await waitFor(() => worker.state === "paused", {
      timeout: 500,
      message: "a local worker was not reached directly",
    });
  });
});

describe("housekeeping", () => {
  it("removes instructions left behind by workers that are gone", async () => {
    const driver = new MemoryDriver();
    const ns = testNamespace("sweep");
    const worker = makeWorker(driver, ns, async () => null, {
      // The sweep rides the once-a-minute pass, whose first run is immediate.
      reportInterval: 1_000,
    });

    await driver.connect();
    await driver.ensureQueue({ ns, queue: "mail" });
    await writeWorkerControl(
      driver,
      { ns, queue: "mail" },
      {
        id: "long.gone",
        key: "svc.mail",
        incarnation: 1,
        state: "stopped",
        at: Date.now() - 3_600_000,
      },
    );
    await writeWorkerStop(driver, { ns, queue: "mail" }, "svc.mail", true);

    void worker.run();

    const { readWorkerControl } = await import("../lib/index");
    await waitFor(
      async () =>
        (await readWorkerControl(
          driver,
          { ns, queue: "mail" },
          "long.gone",
        )) === null,
      { message: "a dead worker's instruction was never swept" },
    );

    // The key-scoped stop is the operator's standing intent and is never
    // swept out from under them.
    expect(
      await readWorkerStop(driver, { ns, queue: "mail" }, "svc.mail"),
    ).not.toBeNull();
  });
});

describe("a remote stop's abandon timeout", () => {
  /**
   * A worker whose processor hangs until the test lets it go, and never
   * finishes merely because it was aborted — so a job abandoned by a stop is
   * still `active` under a lock nobody renews, exactly as it would be in a
   * process that was shut down mid-job.
   */
  async function makeSlowFleet() {
    const driver = new MemoryDriver();
    const ns = testNamespace("stop-timeout");
    const holding = createDeferred<void>();
    const started = createDeferred<void>();
    let aborted = false;

    const worker = makeWorker(
      driver,
      ns,
      async (_job, context) => {
        started.resolve();
        context.signal.addEventListener(
          "abort",
          () => {
            aborted = true;
          },
          { once: true },
        );
        await holding.promise;
        return null;
      },
      // Short enough that the lock lapses inside a test, and a renewal at
      // well under half of it while the job is still being renewed.
      { lockDuration: 1_000, heartbeatInterval: 300 },
    );
    const queue = new BunQueue<unknown, unknown>("mail", {
      namespace: ns,
      driver,
    });

    void worker.run();
    const job = await queue.add("slow", {});
    await started.promise;

    const remote = new RemoteWorker({ namespace: ns, queue: "mail", driver });
    await waitFor(async () => (await remote.list()).length > 0, {
      message: "the worker never registered",
    });

    return {
      driver,
      ns,
      worker,
      remote,
      job,
      holding,
      aborted: () => aborted,
      close: async () => {
        holding.resolve();
        await queue.close();
      },
    };
  }

  it("abandons a job still running once the timeout passes, leaving it recoverable", async () => {
    const fleet = await makeSlowFleet();

    await fleet.remote.stop({ id: fleet.worker.id }, { timeout: 50 });

    await waitFor(() => fleet.worker.state === "stopped", {
      timeout: 3_000,
      message: () =>
        `the stop never gave up on the job; still ${fleet.worker.state}`,
    });
    expect(fleet.aborted()).toBe(true);

    // Abandoning stops the renewal, so the lock lapses and the job comes back
    // through the stalled sweep rather than being lost.
    await Bun.sleep(1_200);
    const { requeued, dead } = await fleet.driver.recoverStalled(
      { ns: fleet.ns, queue: "mail" },
      Date.now(),
      5,
      10,
    );
    expect([...requeued, ...dead]).toContain(fleet.job.id);

    await fleet.close();
  });

  it("waits indefinitely when the stop carries no timeout", async () => {
    const fleet = await makeSlowFleet();

    await fleet.remote.stop({ id: fleet.worker.id });

    // Long enough that a stop with the previous test's timeout would have
    // given up several times over.
    await Bun.sleep(400);
    expect(fleet.worker.state).toBe("stopping");
    expect(fleet.aborted()).toBe(false);

    // And it parks the moment the job finishes of its own accord.
    fleet.holding.resolve();
    await waitFor(() => fleet.worker.state === "stopped", {
      timeout: 3_000,
      message: () => `still ${fleet.worker.state} after the job finished`,
    });

    await fleet.close();
  });

  it("ignores a timeout outside its bounds, stops anyway, and says why", async () => {
    const fleet = await makeSlowFleet();

    // A day: long enough that honouring it would park the worker in
    // `stopping` for a day, which is indistinguishable from a hung drain.
    await fleet.remote.stop({ id: fleet.worker.id }, { timeout: 86_400_000 });

    await Bun.sleep(400);
    // Refused, so it falls back to waiting rather than to abandoning.
    expect(fleet.worker.state).toBe("stopping");
    expect(fleet.aborted()).toBe(false);
    expect(fleet.worker.control.lastError?.action).toBe("stop");
    expect(fleet.worker.control.lastError?.message).toContain("stop timeout");

    fleet.holding.resolve();
    await waitFor(() => fleet.worker.state === "stopped", {
      timeout: 3_000,
      message: () => `the stop itself never applied; ${fleet.worker.state}`,
    });

    await fleet.close();
  });
});
