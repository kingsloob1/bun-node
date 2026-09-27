import type { SummonedExit, WorkerInfo } from "../lib/index";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { toWorkerDto } from "../lib/api/serialize";
import { BunJobs, MemoryDriver, runSummoned } from "../lib/index";
import { SET_SUMMONED_MODE } from "../lib/queue/BunQueueWorker";
import { harness, openHarnesses } from "./api/fixtures";
import { testNamespace, waitFor } from "./helpers";

/**
 * The mode a summoned worker actually runs in, on its record
 * (`WorkerInfo.summon.resolvedMode`) and in `WorkerDto.summon`: what
 * `runSummoned` resolved — its `mode` option, else the summoner's requested
 * `mode`, else `"exit-on-idle"` — beside `mode`, which stays what the
 * summoner asked for and is never defaulted.
 *
 * The worker only carries it: `runSummoned` sets it once, before `run()`,
 * through an internal symbol-keyed setter, and a worker nobody summoned, or
 * one not run by `runSummoned`, writes none. In process, on the memory
 * driver, which stores worker records and queue state (all a summoned worker
 * needs; summoning *from* elsewhere is not under test here).
 */

setDefaultTimeout(30_000);

const perTest: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const created of openHarnesses) {
    expect(created.mismatches()).toEqual([]);
  }
  openHarnesses.length = 0;
  for (const cleanup of perTest.splice(0).reverse()) {
    await cleanup().catch(() => {});
  }
});

/** A context on a fresh memory driver, closed after the test. */
function context(): BunJobs {
  const jobs = new BunJobs({
    namespace: testNamespace("resolved-mode"),
    driver: new MemoryDriver(),
    logger: noopLogger,
  });
  perTest.push(async () => await jobs.close());
  return jobs;
}

/** The options that keep `runSummoned` from touching the test process. */
const IN_TEST = {
  exit: false,
  signals: false,
  // Never idle long enough to stop by itself: the test closes the worker.
  idleFor: 600_000,
} as const;

/** This worker's record, once it has one carrying `summon` (or any, with `any`). */
async function recordOf(
  jobs: BunJobs,
  id: string,
  options: { summoned: boolean } = { summoned: true },
): Promise<WorkerInfo> {
  let found: WorkerInfo | undefined;
  await waitFor(
    async () => {
      found = (await jobs.listWorkers()).find(
        (worker) =>
          worker.id === id &&
          (!options.summoned || worker.summon !== undefined),
      );
      return found !== undefined;
    },
    { timeout: 5000, interval: 10 },
  );
  return found!;
}

describe("the resolved summon mode", () => {
  it("is on the record of a summoned worker runSummoned runs: exit-on-idle, with no mode requested", async () => {
    const jobs = context();
    const worker = jobs.worker("work", async () => {}, {
      summon: { id: "a-1", kind: "fake" },
      reportInterval: 50,
    });
    const run = runSummoned(worker, IN_TEST);

    const record = await recordOf(jobs, worker.id);
    // `mode` is absent — the summoner asked for none, and it is never
    // defaulted — while `resolvedMode` says what the worker is doing.
    expect(record.summon).toEqual({
      id: "a-1",
      kind: "fake",
      resolvedMode: "exit-on-idle",
    });
    expect(worker.summon).toEqual(record.summon);

    await worker.close();
    expect(((await run) as SummonedExit).reason).toBe("closed");
  });

  it("is the option's mode when given, beside the mode the summoner requested", async () => {
    const jobs = context();
    const worker = jobs.worker("work", async () => {}, {
      summon: { id: "a-2", mode: "exit-on-idle" },
      reportInterval: 50,
    });
    const run = runSummoned(worker, { ...IN_TEST, mode: "until-stopped" });
    const record = await recordOf(jobs, worker.id);
    expect(record.summon).toEqual({
      id: "a-2",
      mode: "exit-on-idle",
      resolvedMode: "until-stopped",
    });
    await worker.close();
    await run;
  });

  it("is absent on a summoned worker not run by runSummoned", async () => {
    const jobs = context();
    const worker = jobs.worker("work", async () => {}, {
      summon: { id: "a-3", mode: "until-stopped" },
      reportInterval: 50,
    });
    void worker.run();
    const record = await recordOf(jobs, worker.id);
    expect(record.summon).toEqual({ id: "a-3", mode: "until-stopped" });
    expect(record.summon).not.toHaveProperty("resolvedMode");
    await worker.close();
  });

  it("is absent, with no summon at all, on an unsummoned worker runSummoned runs", async () => {
    const jobs = context();
    const worker = jobs.worker("work", async () => {}, { reportInterval: 50 });
    // Negative control on the setter: nothing to put it on, so refused.
    expect(worker[SET_SUMMONED_MODE]("until-stopped")).toBe(false);
    const run = runSummoned(worker, IN_TEST);
    const record = await recordOf(jobs, worker.id, { summoned: false });
    // Give it a second report, so absence is not just a first write racing.
    await Bun.sleep(120);
    const again = await recordOf(jobs, worker.id, { summoned: false });
    expect(record).not.toHaveProperty("summon");
    expect(again).not.toHaveProperty("summon");
    expect(worker.summon).toBeUndefined();
    await worker.close();
    await run;
  });

  it("is set once, before run(): a second set, and any set after run(), change nothing", async () => {
    const jobs = context();
    const worker = jobs.worker("work", async () => {}, {
      summon: { id: "a-4" },
      reportInterval: 50,
    });
    expect(worker[SET_SUMMONED_MODE]("until-stopped")).toBe(true);
    // A second set is ignored, before run() as after.
    expect(worker[SET_SUMMONED_MODE]("in-invocation")).toBe(false);
    void worker.run();
    const record = await recordOf(jobs, worker.id);
    expect(record.summon?.resolvedMode).toBe("until-stopped");
    expect(worker[SET_SUMMONED_MODE]("exit-on-idle")).toBe(false);
    // The next reports still carry the first value.
    const heartbeat = record.heartbeatAt;
    let later: WorkerInfo | undefined;
    await waitFor(async () => {
      later = await recordOf(jobs, worker.id);
      return later.heartbeatAt > heartbeat;
    });
    expect(later!.summon?.resolvedMode).toBe("until-stopped");
    await worker.close();
    // And on a closed worker too.
    expect(worker[SET_SUMMONED_MODE]("exit-on-idle")).toBe(false);
  });

  it("refuses a set after run() on a worker that never had one", async () => {
    const jobs = context();
    const worker = jobs.worker("work", async () => {}, {
      summon: { id: "a-5" },
      reportInterval: 50,
    });
    void worker.run();
    expect(worker[SET_SUMMONED_MODE]("until-stopped")).toBe(false);
    const record = await recordOf(jobs, worker.id);
    expect(record.summon).toEqual({ id: "a-5" });
    await worker.close();
  });

  it("is passed through WorkerDto.summon whatever exposeSummonHandles says: it is only a mode", async () => {
    const summon = {
      id: "a-6",
      handle: "arn:aws:ecs:eu-west-1:123456789012:task/x",
      resolvedMode: "exit-on-idle",
    } as const;
    const record = {
      id: "w",
      queue: "work",
      host: "h",
      pid: 1,
      concurrency: 1,
      active: 0,
      paused: false,
      startedAt: 1,
      heartbeatAt: 2,
      expiresAt: 3,
      summon,
    } satisfies WorkerInfo;
    expect(
      toWorkerDto(record, { exposeHosts: false, exposeSummonHandles: false })
        .summon,
    ).toEqual({ id: "a-6", resolvedMode: "exit-on-idle" });
    expect(
      toWorkerDto(record, { exposeHosts: false, exposeSummonHandles: true })
        .summon,
    ).toEqual(summon);
  });

  it("reaches the management API's worker routes, and their schema accepts it", async () => {
    const jobs = context();
    const worker = jobs.worker("work", async () => {}, {
      summon: { id: "a-7" },
      reportInterval: 50,
    });
    const run = runSummoned(worker, IN_TEST);
    await recordOf(jobs, worker.id);

    // `validateResponses` is on in the harness: a field the schema did not
    // declare would be a mismatch, checked after each test.
    const h = harness({ jobs });
    const one = await h.call("GET", `/queues/work/workers/${worker.id}`);
    expect(one.status).toBe(200);
    expect(one.body.summon).toEqual({
      id: "a-7",
      resolvedMode: "exit-on-idle",
    });
    const list = await h.call("GET", "/workers");
    expect(
      list.body.items.find((entry: { id: string }) => entry.id === worker.id)
        .summon,
    ).toEqual({ id: "a-7", resolvedMode: "exit-on-idle" });

    await worker.close();
    await run;
  });
});
