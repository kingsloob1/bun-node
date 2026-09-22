import type { JobsDriver } from "../lib/index";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import { createJobsApi } from "../lib/api/createJobsApi";
import { BunJobs, FileDriver, SqlDriver } from "../lib/index";
import { makeTmpDir, testNamespace, waitFor } from "./helpers";

/**
 * B18: on a polling driver, stopping an idle worker with `?wait=` answers the
 * state the stop produced — `stopped`, not pending — while a worker still
 * draining a job answers `stopping` and pending, as before.
 */

const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup().catch(() => undefined);
  }
});

/** The polling backends the report names. */
const BACKENDS: [string, () => Promise<JobsDriver>][] = [
  [
    "file",
    async () => {
      const dir = await makeTmpDir("b18");
      cleanups.push(dir.cleanup);
      return new FileDriver({ root: dir.path });
    },
  ],
  [
    "sqlite",
    async () => {
      const dir = await makeTmpDir("b18-sql");
      cleanups.push(dir.cleanup);
      return new SqlDriver({ url: `sqlite://${dir.path}/jobs.db` });
    },
  ],
];

interface StopBody {
  applied?: boolean;
  worker?: { state?: string; control?: { pending?: boolean } };
}

/** A context, an API over it, and a worker on `emails` that runs `processor`. */
async function setup(
  makeDriver: () => Promise<JobsDriver>,
  processor: () => Promise<void>,
) {
  const driver = await makeDriver();
  const namespace = testNamespace("b18");
  const jobs = new BunJobs({
    namespace,
    driver,
    service: "api",
    logger: noopLogger,
  });
  const worker = jobs.worker("emails", processor, {
    stopPersistenceOverridable: true,
    reportInterval: 500,
    pollInterval: 20,
    waitToExit: false,
    remoteControl: { interval: 100 },
  });
  cleanups.push(async () => {
    await jobs.close();
    await driver.close();
  });
  void worker.run();
  await waitFor(() => worker.isRunning, { timeout: 5_000 });
  await Bun.sleep(300);
  const api = createJobsApi({
    jobs,
    basePath: "/api",
    authorize: () => true,
    logger: noopLogger,
  });

  /** Sends the stop, waiting up to 2s for the acknowledgement. */
  async function stop(): Promise<{ status: number; body: StopBody }> {
    const response = await api.router.fetch(
      `/queues/emails/workers/${worker.id}/stop?wait=2000`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    return {
      status: response.status,
      body: (await response.json()) as StopBody,
    };
  }

  return { jobs, worker, stop };
}

for (const [name, makeDriver] of BACKENDS) {
  describe(`stop ?wait= on an idle worker: ${name} (B18)`, () => {
    it("answers stopped, not pending", async () => {
      const { stop, worker } = await setup(makeDriver, async () => {});
      const { status, body } = await stop();

      expect(status).toBe(200);
      expect(body.applied).toBe(true);
      expect(body.worker?.state).toBe("stopped");
      expect(body.worker?.control?.pending).toBe(false);
      expect(worker.state).toBe("stopped");
    }, 15_000);

    it("answers stopping and pending while a job drains", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { jobs, stop, worker } = await setup(makeDriver, async () => {
        await gate;
      });
      cleanups.push(async () => release());
      await jobs.queue("emails").add("send", {});
      await waitFor(() => worker.activeCount === 1, { timeout: 5_000 });

      const { status, body } = await stop();
      expect(status).toBe(200);
      expect(body.worker?.state).toBe("stopping");
      expect(body.worker?.control?.pending).toBe(true);

      release();
      await waitFor(() => worker.state === "stopped", { timeout: 5_000 });
    }, 15_000);
  });
}
