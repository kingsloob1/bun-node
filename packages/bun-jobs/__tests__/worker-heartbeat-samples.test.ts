import type { WorkerInfo } from "../lib/index";
import process from "node:process";
import { afterEach, describe, expect, it } from "bun:test";
import { toWorkerDto } from "../lib/api/serialize";
import { BunQueueWorker, MemoryDriver } from "../lib/index";
import { testNamespace, waitFor } from "./helpers";

/**
 * The two samples the heartbeat carries besides its counts: `rssBytes`, the
 * **process's** resident memory, and `heartbeatRttMs`, how long the last write
 * to the driver took.
 *
 * Both ride the write the worker makes anyway — no timer of their own, no
 * driver call of their own — so what is asserted here is where each number
 * comes from, not that some number arrived.
 */

/** Workers to close after each test. */
const workers: BunQueueWorker<unknown, unknown>[] = [];
/** `process.memoryUsage.rss` as it was, restored after a test that stubbed it. */
let realRss: typeof process.memoryUsage.rss | undefined;

afterEach(async () => {
  await Promise.allSettled(
    workers
      .splice(0)
      .map(async (worker) => await worker.close({ force: true })),
  );
  if (realRss) {
    process.memoryUsage.rss = realRss;
    realRss = undefined;
  }
});

/** A reporting worker with nothing to do, closed after the test. */
function makeWorker(
  driver: MemoryDriver,
  ns: string,
  queue: string,
  id?: string,
): BunQueueWorker<unknown, unknown> {
  const worker = new BunQueueWorker<unknown, unknown>(queue, async () => null, {
    namespace: ns,
    driver,
    ...(id === undefined ? {} : { id }),
    reportInterval: 40,
    pollInterval: 10,
    waitToExit: false,
  });
  workers.push(worker);
  void worker.run();
  return worker;
}

/** The queue's live records, straight from the driver. */
async function records(
  driver: MemoryDriver,
  ns: string,
  queue: string,
): Promise<WorkerInfo[]> {
  return await driver.listWorkers({ ns, queue }, Date.now());
}

/** Waits for one worker's record to satisfy `ready`, and answers it. */
async function recordWhen(
  driver: MemoryDriver,
  ns: string,
  queue: string,
  id: string,
  ready: (info: WorkerInfo) => boolean,
): Promise<WorkerInfo> {
  let found: WorkerInfo | undefined;
  await waitFor(
    async () => {
      found = (await records(driver, ns, queue)).find(
        (info) => info.id === id && ready(info),
      );
      return found !== undefined;
    },
    {
      timeout: 5_000,
      message: async () =>
        `no such record for ${id}: ${JSON.stringify(await records(driver, ns, queue))}`,
    },
  );
  return found!;
}

describe("the heartbeat's rssBytes and heartbeatRttMs", () => {
  it("carries both once a write has completed, with plausible values", async () => {
    const driver = new MemoryDriver();
    const ns = testNamespace("hb-samples");
    const worker = makeWorker(driver, ns, "mail");

    // `heartbeatRttMs` appears on the *second* report: a write cannot time
    // itself, so the first record has nothing to report yet.
    const info = await recordWhen(
      driver,
      ns,
      "mail",
      worker.id,
      (record) => record.heartbeatRttMs !== undefined,
    );

    expect(Number.isInteger(info.rssBytes)).toBe(true);
    // A Bun process running a test suite is never under a megabyte resident.
    expect(info.rssBytes!).toBeGreaterThan(1_000_000);
    expect(Number.isFinite(info.heartbeatRttMs)).toBe(true);
    expect(info.heartbeatRttMs!).toBeGreaterThanOrEqual(0);
    // An in-process write, so far under one report interval.
    expect(info.heartbeatRttMs!).toBeLessThan(40);
  });

  it("leaves heartbeatRttMs off the first record, which still carries rssBytes", async () => {
    const driver = new MemoryDriver();
    const ns = testNamespace("hb-first");
    const worker = makeWorker(driver, ns, "mail");

    const first = await recordWhen(driver, ns, "mail", worker.id, () => true);

    // Whichever report this caught, `rssBytes` is always there; and if it is
    // the first, there is no round trip to report yet.
    expect(typeof first.rssBytes).toBe("number");
    if (first.heartbeatRttMs === undefined) {
      expect("heartbeatRttMs" in first).toBe(false);
    }
  });

  it("gives two workers in one process the same rssBytes: it is the process's", async () => {
    // Stubbed, because the claim is about the *source*: whatever the process
    // reports, both records carry that one number. A live reading would drift
    // between the two reports and prove nothing either way.
    const stubbed = 123_456_789;
    realRss = process.memoryUsage.rss;
    process.memoryUsage.rss = () => stubbed;

    const driver = new MemoryDriver();
    const ns = testNamespace("hb-shared");
    const one = makeWorker(driver, ns, "mail", "mail.one");
    const two = makeWorker(driver, ns, "mail", "mail.two");

    const both = await Promise.all([
      recordWhen(driver, ns, "mail", one.id, (r) => r.rssBytes !== undefined),
      recordWhen(driver, ns, "mail", two.id, (r) => r.rssBytes !== undefined),
    ]);

    expect(both.map((info) => info.rssBytes)).toEqual([stubbed, stubbed]);
    // Which is exactly why a workers table must never sum the column.
    expect(both[0]!.rssBytes).toBe(both[1]!.rssBytes);
  });

  it("reads a record written without them: absent, not zero", async () => {
    const driver = new MemoryDriver();
    const ns = testNamespace("hb-older");
    const now = Date.now();
    // What a worker from before these fields wrote.
    const older: WorkerInfo = {
      id: "mail.old",
      key: "mail",
      queue: "mail",
      host: "test-host",
      pid: 4_242,
      concurrency: 1,
      active: 0,
      paused: false,
      startedAt: now - 1_000,
      heartbeatAt: now,
      expiresAt: now + 60_000,
    };
    await driver.registerWorker({ ns, queue: "mail" }, older);

    const [read] = await records(driver, ns, "mail");
    expect(read!.rssBytes).toBeUndefined();
    expect(read!.heartbeatRttMs).toBeUndefined();
    expect("rssBytes" in read!).toBe(false);
    expect("heartbeatRttMs" in read!).toBe(false);

    // And the DTO leaves them out rather than defaulting them to `0`.
    const dto = toWorkerDto(read!, { exposeHosts: true }, now);
    expect("rssBytes" in dto).toBe(false);
    expect("heartbeatRttMs" in dto).toBe(false);
  });
});
