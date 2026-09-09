import { afterAll, describe, expect, it } from "bun:test";
import { FileDriver } from "../lib/index";
import { makeJob, makeTmpDir, testNamespace } from "./helpers";
import { driverContract } from "./helpers/driverContract";

/**
 * The file driver against the shared contract, plus the guarantees that are
 * specific to a filesystem: markers healing after a crash, and one directory
 * per namespace.
 */

const cleanups: (() => Promise<void>)[] = [];

afterAll(async () => {
  await Promise.allSettled(cleanups.map((cleanup) => cleanup()));
});

driverContract("file", async () => {
  const tmp = await makeTmpDir("bun-jobs-contract");
  cleanups.push(tmp.cleanup);
  return { driver: new FileDriver({ root: tmp.path }) };
});

describe("file driver: filesystem specifics", () => {
  it("heals an index marker whose record is gone", async () => {
    const tmp = await makeTmpDir("bun-jobs-heal");
    cleanups.push(tmp.cleanup);

    const driver = new FileDriver({ root: tmp.path });
    await driver.connect();

    const q = { ns: testNamespace(), queue: "healing" };
    const now = Date.now();
    await driver.addJob(q, makeJob({ id: "ghost", runAt: now }));

    // Simulate a crash between the record write and the marker write by
    // deleting the record out from under the index.
    const { rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await rm(join(tmp.path, q.ns, "queues", q.queue, "jobs", "ghost.json"));

    // The claim must skip and clean up rather than hand out a broken job.
    expect(
      await driver.claimJob(q, {
        workerId: "w1",
        token: "t1",
        lockMs: 1000,
        now,
      }),
    ).toBeNull();
    expect((await driver.countJobs(q)).waiting).toBe(0);

    await driver.close();
  });

  it("gives each namespace its own directory", async () => {
    const tmp = await makeTmpDir("bun-jobs-ns");
    cleanups.push(tmp.cleanup);

    const driver = new FileDriver({ root: tmp.path });
    await driver.connect();

    const first = testNamespace("alpha");
    const second = testNamespace("beta");
    await driver.addJob({ ns: first, queue: "shared" }, makeJob({ id: "x" }));
    await driver.addJob({ ns: second, queue: "shared" }, makeJob({ id: "x" }));

    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(tmp.path);
    expect(entries).toContain(first);
    expect(entries).toContain(second);

    await driver.purge(first);
    expect(await readdir(tmp.path)).not.toContain(first);
    expect(
      await driver.getJob({ ns: second, queue: "shared" }, "x"),
    ).not.toBeNull();

    await driver.close();
  });

  it("keeps claim order across a restart", async () => {
    const tmp = await makeTmpDir("bun-jobs-order");
    cleanups.push(tmp.cleanup);

    const ns = testNamespace();
    const q = { ns, queue: "ordered" };
    const now = Date.now();

    const first = new FileDriver({ root: tmp.path });
    await first.connect();
    await first.addJobs(q, [
      makeJob({ id: "a", priority: 0, createdAt: now, runAt: now }),
      makeJob({ id: "b", priority: -1, createdAt: now + 1, runAt: now }),
      makeJob({ id: "c", priority: 0, createdAt: now + 2, runAt: now }),
    ]);
    await first.close();

    // A different instance — a restarted process — sees the same order,
    // because the order lives in the index file names.
    const second = new FileDriver({ root: tmp.path });
    await second.connect();

    const claimed: string[] = [];
    for (let i = 0; i < 3; i++) {
      const job = await second.claimJob(q, {
        workerId: "w",
        token: `t${i}`,
        lockMs: 5000,
        now,
      });
      if (job) {
        claimed.push(job.id);
      }
    }

    expect(claimed).toEqual(["b", "a", "c"]);
    await second.close();
  });
});
