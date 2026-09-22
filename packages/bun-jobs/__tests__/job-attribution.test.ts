import type { JobQuery, JobsDriver } from "../lib/index";
import { afterEach, describe, expect, it } from "bun:test";
import {
  attributionFilter,
  attributionOf,
  canMatchState,
  holderOf,
  matchesAttribution,
  matchesNothing,
  supportsAttributionQuery,
  usesAttribution,
} from "../lib/drivers/index";
import { BunQueue, ConfigError, MemoryDriver, newToken } from "../lib/index";
import { makeJob, testNamespace } from "./helpers";

/**
 * Job attribution through the queue, and the shared definitions every backend
 * matches against. Each backend's half — the stamp, its survival, the filters —
 * is the "job attribution" block of `helpers/driverContract.ts`.
 */

/** Closed after each test, in reverse order of creation. */
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (closers.length > 0) {
    await closers.pop()!().catch(() => undefined);
  }
});

/** A queue on a driver, closed after the test. */
function makeQueue(driver: JobsDriver): BunQueue {
  const queue = new BunQueue("attr", {
    namespace: testNamespace("attr"),
    driver,
  });
  closers.push(async () => await queue.close());
  return queue;
}

/** One worker's identity, as a worker passes it to the claim. */
const ALPHA = { key: "svc.attr", host: "host-a", pid: 11 };

describe("attribution definitions", () => {
  it("stamps the id alone, or the id with key, host and pid", () => {
    expect(attributionOf({ workerId: "w-1" })).toEqual({ id: "w-1" });
    expect(attributionOf({ workerId: "w-1", worker: ALPHA })).toEqual({
      id: "w-1",
      ...ALPHA,
    });
  });

  it("reports a holder only while active", () => {
    expect(holderOf("active", { id: "w-1" })).toBe("w-1");
    expect(holderOf("completed", { id: "w-1" })).toBeNull();
    expect(holderOf("active", null)).toBeNull();
    expect(holderOf("active", undefined)).toBeNull();
  });

  it("knows a query that uses none of the filters", () => {
    expect(usesAttribution({})).toBe(false);
    expect(attributionFilter({})).toBeNull();
    expect(usesAttribution({ workerKeys: [] })).toBe(true);
    expect(usesAttribution({ finishedTo: 0 })).toBe(true);
  });

  it("matches a range on finished states only, [from, to)", () => {
    const filter = attributionFilter({ finishedFrom: 10, finishedTo: 20 })!;
    const at = (
      state: "completed" | "dead" | "failed",
      finishedOn: number | null,
    ): boolean =>
      matchesAttribution(filter, { state, finishedOn, processedBy: null });

    expect(at("completed", 10)).toBe(true);
    expect(at("dead", 19)).toBe(true);
    expect(at("completed", 20)).toBe(false);
    expect(at("completed", 9)).toBe(false);
    expect(at("completed", null)).toBe(false);
    // A record claiming a finish while not finished still does not match.
    expect(at("failed", 15)).toBe(false);

    expect(canMatchState(filter, "waiting")).toBe(false);
    expect(canMatchState(filter, "dead")).toBe(true);
    expect(matchesNothing(filter, ["waiting", "active"])).toBe(true);
    expect(matchesNothing(filter, ["waiting", "completed"])).toBe(false);
  });

  it("matches nothing for an empty list or an empty range", () => {
    expect(
      matchesNothing(attributionFilter({ workerKeys: [] })!, ["completed"]),
    ).toBe(true);
    expect(
      matchesNothing(attributionFilter({ workerIds: [] })!, ["completed"]),
    ).toBe(true);
    expect(
      matchesNothing(attributionFilter({ finishedFrom: 5, finishedTo: 5 })!, [
        "completed",
      ]),
    ).toBe(true);
    expect(
      matchesNothing(attributionFilter({ workerKeys: ["k"] })!, ["waiting"]),
    ).toBe(false);
  });

  it("matches keys and ids exactly, and never a key on a keyless stamp", () => {
    const record = (processedBy: { id: string; key?: string } | null) => ({
      state: "completed" as const,
      finishedOn: 1,
      processedBy,
    });
    const byKey = attributionFilter({ workerKeys: ["svc.attr"] })!;
    const byId = attributionFilter({ workerIds: ["w-1"] })!;

    expect(
      matchesAttribution(byKey, record({ id: "w-1", key: "svc.attr" })),
    ).toBe(true);
    expect(
      matchesAttribution(byKey, record({ id: "w-1", key: "SVC.ATTR" })),
    ).toBe(false);
    expect(matchesAttribution(byKey, record({ id: "svc.attr" }))).toBe(false);
    expect(matchesAttribution(byKey, record(null))).toBe(false);
    expect(matchesAttribution(byId, record({ id: "w-1" }))).toBe(true);
    expect(matchesAttribution(byId, record({ id: "w-12" }))).toBe(false);
  });

  it("trusts a driver's findJobs only on a declared capability", () => {
    const driver = new MemoryDriver();
    // The memory driver records attribution and declares it.
    expect(driver.capabilities.jobAttribution).toBe(true);
    expect(supportsAttributionQuery(driver)).toBe(true);
    // Without the declaration, the same findJobs is not trusted.
    expect(
      supportsAttributionQuery({
        capabilities: { ...driver.capabilities, jobAttribution: false },
        findJobs: driver.findJobs.bind(driver),
      }),
    ).toBe(false);
    expect(
      supportsAttributionQuery({
        capabilities: { ...driver.capabilities, jobAttribution: true },
        findJobs: driver.findJobs.bind(driver),
      }),
    ).toBe(true);
    expect(
      supportsAttributionQuery({
        capabilities: { ...driver.capabilities, jobAttribution: true },
      }),
    ).toBe(false);
    // A bare queue driver carries no capabilities at all.
    expect(
      supportsAttributionQuery({ findJobs: driver.findJobs.bind(driver) }),
    ).toBe(false);
  });
});

describe("attribution through the queue", () => {
  /** Adds, claims as `workerId` and completes `id` at `finishedOn`. */
  async function run(
    queue: BunQueue,
    driver: JobsDriver,
    id: string,
    workerId: string,
    worker: typeof ALPHA | undefined,
    finishedOn: number,
  ): Promise<void> {
    const ref = { ns: queue.namespace, queue: queue.name };
    await driver.addJob(
      ref,
      makeJob({ id, runAt: finishedOn - 100, createdAt: finishedOn - 100 }),
    );
    const token = newToken();
    const claimed = await driver.claimJob(ref, {
      workerId,
      token,
      lockMs: 30_000,
      now: finishedOn - 50,
      ...(worker ? { worker } : {}),
    });
    expect(claimed?.id).toBe(id);
    await driver.completeJob(ref, id, token, null, false, finishedOn);
  }

  it("exposes processedBy on a Job, kept after completion", async () => {
    const driver = new MemoryDriver();
    const queue = makeQueue(driver);
    await queue.connect();
    await run(queue, driver, "one", "alpha-1", ALPHA, 1_000);

    const job = await queue.getJob("one");
    expect(job?.state).toBe("completed");
    expect(job?.workerId).toBeNull();
    expect(job?.processedBy).toEqual({ id: "alpha-1", ...ALPHA });

    await queue.add("fresh", {});
    const [fresh] = await queue.list("waiting");
    expect(fresh?.processedBy).toBeNull();
  });

  it("lists and pages by worker and finish time, one value or several", async () => {
    const driver = new MemoryDriver();
    const queue = makeQueue(driver);
    await queue.connect();
    await run(queue, driver, "a1", "alpha-1", ALPHA, 1_000);
    await run(queue, driver, "a2", "alpha-2", ALPHA, 2_000);
    await run(
      queue,
      driver,
      "b1",
      "bravo-1",
      { key: "svc.other", host: "h", pid: 2 },
      3_000,
    );

    const ids = async (
      options: Parameters<BunQueue["list"]>[1],
    ): Promise<string[]> =>
      (await queue.list("completed", options)).map((job) => job.id);

    expect(await ids({ workerKey: "svc.attr" })).toEqual(["a1", "a2"]);
    expect(await ids({ workerKey: ["svc.attr", "svc.other"] })).toEqual([
      "a1",
      "a2",
      "b1",
    ]);
    expect(await ids({ workerKey: [] })).toEqual([]);
    expect(await ids({ workerId: "bravo-1" })).toEqual(["b1"]);
    expect(await ids({ finishedFrom: 2_000 })).toEqual(["a2", "b1"]);
    expect(await ids({ finishedTo: new Date(2_000) })).toEqual(["a1"]);
    expect(
      await ids({
        workerKey: "svc.attr",
        finishedFrom: new Date(1_500),
        finishedTo: 3_000,
      }),
    ).toEqual(["a2"]);

    const page = await queue.page("completed", {
      workerKey: "svc.attr",
      limit: 1,
    });
    expect(page.jobs.map((job) => job.id)).toEqual(["a1"]);
    expect(page.total).toBe(2);
  });

  it("never hands the filters to a findJobs that does not declare them", async () => {
    const memory = new MemoryDriver();
    const seen: JobQuery[] = [];
    // A driver whose `findJobs` predates the fields: it would return every job.
    const driver = new Proxy(memory, {
      get(target, property) {
        // …and declares nothing, as such a driver would not.
        if (property === "capabilities") {
          return { ...target.capabilities, jobAttribution: false };
        }
        if (property === "findJobs") {
          return async (...args: Parameters<MemoryDriver["findJobs"]>) => {
            seen.push(args[1]);
            return await target.findJobs(args[0], {
              ...args[1],
              workerKeys: undefined,
              finishedFrom: undefined,
            });
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const queue = makeQueue(driver);
    await queue.connect();
    await run(queue, memory, "a1", "alpha-1", ALPHA, 1_000);
    await run(queue, memory, "x1", "other-1", undefined, 1_000);

    // A range needs no stamp, so it is answered — by the scan, which
    // honours it, never by that findJobs, which would return both jobs.
    expect(await queue.list("completed", { finishedFrom: 2_000 })).toEqual([]);
    expect(
      (await queue.list("completed", { finishedFrom: 0 }))
        .map((job) => job.id)
        .sort(),
    ).toEqual(["a1", "x1"]);
    // A worker filter has no stamp to match on a driver that declares none:
    // refused, as the API refuses it, rather than scanned to an empty page.
    await expect(
      queue.list("completed", { workerKey: "svc.attr" }),
    ).rejects.toBeInstanceOf(ConfigError);
    expect(
      seen.some(
        (query) =>
          query.workerKeys !== undefined || query.finishedFrom !== undefined,
      ),
    ).toBe(false);
  });

  it("refuses a bound that is not a date or timestamp", async () => {
    const queue = makeQueue(new MemoryDriver());
    await expect(
      queue.list("completed", { finishedFrom: Number.NaN }),
    ).rejects.toBeInstanceOf(ConfigError);
    await expect(
      queue.page("completed", { finishedTo: new Date("nope") }),
    ).rejects.toBeInstanceOf(ConfigError);
  });
});
