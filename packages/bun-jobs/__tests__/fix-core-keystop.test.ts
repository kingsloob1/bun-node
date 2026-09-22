import type { BunQueueWorker } from "../lib/index";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import { BunJobs, MemoryDriver, readWorkerStop } from "../lib/index";
import { testNamespace, waitFor } from "./helpers";

/**
 * B14: a stop asked to outlive the process (`persist: "key"`) of a worker
 * that may be asked for it (`stopPersistenceOverridable`) is honoured by its
 * replacement, and a deliberate start clears it.
 */

const contexts: BunJobs[] = [];

afterEach(async () => {
  await Promise.allSettled(contexts.map(async (jobs) => jobs.close()));
  contexts.length = 0;
});

/** A context on `driver`, closed after the test. */
function context(driver: MemoryDriver, ns: string, service?: string): BunJobs {
  const jobs = new BunJobs({
    namespace: ns,
    driver,
    logger: noopLogger,
    ...(service ? { service } : {}),
  });
  contexts.push(jobs);
  return jobs;
}

const OVERRIDABLE = {
  stopPersistence: "process",
  stopPersistenceOverridable: true,
  remoteControl: { interval: 100 },
  waitToExit: false,
} as const;

/** Starts a worker on `q` and waits until it runs. */
async function started(
  jobs: BunJobs,
  options: Parameters<BunJobs["worker"]>[2],
): Promise<BunQueueWorker<unknown, unknown>> {
  const worker = jobs.worker("q", async () => "ok", options);
  void worker.run();
  await waitFor(() => worker.isRunning);
  // Past its first heartbeat and its control subscription.
  await Bun.sleep(200);
  return worker as BunQueueWorker<unknown, unknown>;
}

/** Stops `worker` remotely with `persist: "key"` and closes its context. */
async function stopForGood(
  driver: MemoryDriver,
  ns: string,
  jobs: BunJobs,
  worker: BunQueueWorker<unknown, unknown>,
): Promise<void> {
  const remote = context(driver, ns).workers.remote("q");
  await remote.stop({ id: worker.id }, { persist: "key" });
  await waitFor(() => worker.state === "stopped", { timeout: 3_000 });
  await jobs.close();
}

describe("key stops on an overridable worker (B14)", () => {
  it("brings the replacement up stopped", async () => {
    const driver = new MemoryDriver();
    const ns = testNamespace("b14");
    const first = context(driver, ns, "svc");
    const worker = await started(first, OVERRIDABLE);
    await stopForGood(driver, ns, first, worker);

    const replacement = await started(context(driver, ns, "svc"), OVERRIDABLE);
    expect(replacement.state).toBe("stopped");
  });

  it("is cleared by a deliberate start, so later replacements run", async () => {
    const driver = new MemoryDriver();
    const ns = testNamespace("b14start");
    const first = context(driver, ns, "svc");
    const worker = await started(first, OVERRIDABLE);
    await stopForGood(driver, ns, first, worker);

    const second = context(driver, ns, "svc");
    const replacement = await started(second, OVERRIDABLE);
    expect(replacement.state).toBe("stopped");

    // A plain start, with no `persist` of its own.
    await context(driver, ns).workers.remote("q").start({ id: replacement.id });
    await waitFor(() => replacement.state === "running", { timeout: 3_000 });
    await waitFor(
      async () =>
        (await readWorkerStop(driver, { ns, queue: "q" }, replacement.key)) ===
        null,
      { timeout: 3_000 },
    );
    await second.close();

    const third = await started(context(driver, ns, "svc"), OVERRIDABLE);
    expect(third.state).toBe("running");
  });

  it("is cleared by a local start() too", async () => {
    const driver = new MemoryDriver();
    const ns = testNamespace("b14local");
    const first = context(driver, ns, "svc");
    const worker = await started(first, OVERRIDABLE);
    await stopForGood(driver, ns, first, worker);

    const replacement = await started(context(driver, ns, "svc"), OVERRIDABLE);
    expect(replacement.state).toBe("stopped");
    replacement.start();
    await waitFor(
      async () =>
        (await readWorkerStop(driver, { ns, queue: "q" }, replacement.key)) ===
        null,
      { timeout: 3_000 },
    );
  });

  it("leaves a non-overridable process worker running", async () => {
    const driver = new MemoryDriver();
    const ns = testNamespace("b14proc");
    const first = context(driver, ns, "svc");
    const worker = await started(first, OVERRIDABLE);
    await stopForGood(driver, ns, first, worker);

    // The marker is there, and this worker's process decides: it runs.
    expect(
      await readWorkerStop(driver, { ns, queue: "q" }, worker.key),
    ).not.toBeNull();
    const plain = await started(context(driver, ns, "svc"), {
      stopPersistence: "process",
      remoteControl: { interval: 100 },
      waitToExit: false,
    });
    await Bun.sleep(150);
    expect(plain.state).toBe("running");
  });
});
