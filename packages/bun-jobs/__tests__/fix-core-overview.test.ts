import { BunRouter, noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import { createJobsApi } from "../lib/api/createJobsApi";
import { BunJobs, MemoryDriver } from "../lib/index";
import { testNamespace } from "./helpers";

/**
 * C13: `/overview` reads the worker list once per request (the count and the
 * analytics roll-up share it), and its sections run together.
 */

const closers: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  await Promise.allSettled(closers.map((close) => close()));
  closers.length = 0;
});

describe("GET /overview: one worker read per request (C13)", () => {
  it("lists each queue's workers once and still counts them", async () => {
    const driver = new MemoryDriver();
    const namespace = testNamespace();
    const jobs = new BunJobs({ namespace, driver, logger: noopLogger });
    closers.push(() => jobs.close());

    const now = Date.now();
    const queues = ["a", "b", "c", "d"];
    for (const [index, queue] of queues.entries()) {
      await jobs.queue(queue).add("x", {});
      await driver.registerWorker(
        { ns: namespace, queue },
        {
          id: `w${index}`,
          key: `k${index}`,
          queue,
          host: "h",
          pid: 1,
          concurrency: 1,
          active: 0,
          paused: false,
          startedAt: now,
          heartbeatAt: now,
          expiresAt: now + 60_000,
        },
      );
    }

    const api = createJobsApi({
      basePath: "/admin/jobs",
      logger: noopLogger,
      jobs,
      authorize: () => true,
      limits: { queueCacheMs: 0 },
    });
    const root = new BunRouter();
    root.use(api.basePath, api.router);

    let workerReads = 0;
    const original = driver.listWorkers.bind(driver);
    driver.listWorkers = async (...args: Parameters<typeof original>) => {
      workerReads++;
      return await original(...args);
    };

    const response = await root.fetch("/admin/jobs/overview");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      workers?: number;
      analytics?: { workers?: { rows: unknown[] } };
    };
    expect(body.workers).toBe(4);
    // The memory driver serves grouped reads, so the roll-up needs the list
    // too — and gets the same one.
    expect(body.analytics?.workers).toBeDefined();
    expect(workerReads).toBe(queues.length);
  });
});
