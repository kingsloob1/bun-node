import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import { BunQueue, BunQueueWorker, MemoryDriver } from "../lib/index";
import { testNamespace, waitFor } from "./helpers";

/**
 * Closing a worker whose processor will not stop.
 *
 * A processor that ignores its abort signal must neither hold shutdown
 * hostage nor strand its job: once the worker gives up on it, the lock has to
 * lapse so a stalled sweep — here, another worker's — returns the job to the
 * queue. Both used to fail: a forced close left the heartbeat renewing the
 * lock forever, and a graceful close that timed out waited on the job anyway.
 */

const closers: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close().catch(() => undefined);
  }
});

/** A queue, a worker whose processor never settles, and a rescuer to start later. */
async function stuckWorker() {
  const driver = new MemoryDriver();
  const namespace = testNamespace();
  const queue = new BunQueue("stuck", {
    namespace,
    driver,
    logger: noopLogger,
  });
  closers.push(() => queue.close());

  let started = false;
  const stuck = new BunQueueWorker(
    "stuck",
    () => {
      started = true;
      // Ignores its signal and never settles.
      return new Promise<never>(() => {});
    },
    {
      namespace,
      driver,
      logger: noopLogger,
      lockDuration: 300,
      heartbeatInterval: 50,
      pollInterval: 5,
      // Its own sweep must not be what rescues the job.
      maintenance: false,
    },
  );
  void stuck.run();

  const job = await queue.add("hang", {});
  await waitFor(() => started, { timeout: 5_000 });

  /** Starts another worker, and records what its stalled sweep recovers. */
  function rescuer() {
    const recovered: string[] = [];
    const worker = new BunQueueWorker("stuck", async () => null, {
      namespace,
      driver,
      logger: noopLogger,
      lockDuration: 300,
      stalledInterval: 100,
      pollInterval: 5,
      maxStalledCount: 5,
    });
    worker.on("stalled", (ids) => recovered.push(...ids));
    closers.push(() => worker.close({ force: true }));
    void worker.run();
    return recovered;
  }

  return { job, queue, stuck, rescuer };
}

describe("closing a worker whose processor ignores its signal", () => {
  it("a forced close lets the lock lapse, so another worker recovers the job", async () => {
    const { job, queue, stuck, rescuer } = await stuckWorker();

    await stuck.close({ force: true });
    const recovered = rescuer();

    await waitFor(() => recovered.includes(job.id), {
      timeout: 5_000,
      message: "the force-closed worker kept renewing the job's lock",
    });
    await waitFor(
      async () => (await queue.getJob(job.id))?.state === "completed",
      { timeout: 5_000 },
    );
  }, 15_000);

  it("a graceful close that times out returns, and the job is recovered", async () => {
    const { job, queue, stuck, rescuer } = await stuckWorker();

    const outcome = await Promise.race([
      stuck.close({ timeout: 100 }).then(() => "closed" as const),
      Bun.sleep(3_000).then(() => "hung" as const),
    ]);
    expect(outcome).toBe("closed");

    const recovered = rescuer();
    await waitFor(() => recovered.includes(job.id), {
      timeout: 5_000,
      message: "the timed-out close left the job's lock renewing",
    });
    await waitFor(
      async () => (await queue.getJob(job.id))?.state === "completed",
      { timeout: 5_000 },
    );
  }, 15_000);
});
