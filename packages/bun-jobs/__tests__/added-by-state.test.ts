import type { JobQuery, JobsDriver } from "../lib/index";
import { afterEach, describe, expect, it } from "bun:test";
import {
  compareCreated,
  countAdded,
  countAddedByScan,
  emptyAddedCounts,
  findJobPage,
  inAddedRange,
  rangeMatchesNothing,
  sortByCreated,
  sortsByCreated,
  supportsCreatedSort,
} from "../lib/drivers/index";
import {
  BunQueue,
  ConfigError,
  FileDriver,
  MemoryDriver,
  NotSupportedError,
} from "../lib/index";
import { makeJob, makeTmpDir, testNamespace } from "./helpers";

/**
 * Jobs read by when they were added — `countAddedJobs` and
 * `sort: "createdAt"` — through the queue, and the shared definitions every
 * backend matches against. Each backend's half is the "jobs by creation time"
 * block of `helpers/driverContract.ts`.
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
  const queue = new BunQueue("added", {
    namespace: testNamespace("added"),
    driver,
  });
  closers.push(async () => await queue.close());
  return queue;
}

/** U+FFFF, the last code point below the surrogate pairs, spelled out. */
const LAST_BMP = String.fromCodePoint(0xffff);

/** A fixed instant, far in the past, to build around. */
const T = 1_700_000_000_000;

/**
 * A memory driver as a driver written before `countAddedJobs` would look:
 * the method absent, and `findJobs` recording every query it is handed while
 * ignoring `sort`, exactly as such a driver would.
 */
function withoutAdded(): { driver: MemoryDriver; seen: JobQuery[] } {
  const memory = new MemoryDriver();
  const seen: JobQuery[] = [];
  const driver = new Proxy(memory, {
    get(target, property) {
      if (property === "countAddedJobs") {
        return undefined;
      }
      if (property === "findJobs") {
        return async (...args: Parameters<MemoryDriver["findJobs"]>) => {
          seen.push(args[1]);
          return await target.findJobs(args[0], {
            ...args[1],
            sort: undefined,
          });
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { driver, seen };
}

/**
 * Delayed jobs whose due times run against their creation: natural order
 * `d-3, d-1, d-2`, creation order `d-1, d-2, d-3`.
 */
async function seedDelayed(queue: BunQueue): Promise<void> {
  await queue.driver.addJobs(queue.ref, [
    makeJob({ id: "d-2", state: "delayed", createdAt: T + 2, runAt: T + 900 }),
    makeJob({ id: "d-3", state: "delayed", createdAt: T + 3, runAt: T + 100 }),
    makeJob({ id: "d-1", state: "delayed", createdAt: T + 1, runAt: T + 500 }),
  ]);
}

describe("added definitions", () => {
  it("takes from inclusively and to exclusively", () => {
    const range = { from: 10, to: 20 };
    expect(inAddedRange(range, 9)).toBe(false);
    expect(inAddedRange(range, 10)).toBe(true);
    expect(inAddedRange(range, 19)).toBe(true);
    expect(inAddedRange(range, 20)).toBe(false);
    expect(rangeMatchesNothing(range)).toBe(false);
    expect(rangeMatchesNothing({ from: 10, to: 10 })).toBe(true);
    expect(rangeMatchesNothing({ from: 11, to: 10 })).toBe(true);
  });

  it("starts every state at zero, and counts by the state each job is in", () => {
    expect(Object.keys(emptyAddedCounts()).sort()).toEqual(
      [
        "active",
        "completed",
        "dead",
        "delayed",
        "failed",
        "waiting",
        "waiting-children",
      ].sort(),
    );
    expect(Object.values(emptyAddedCounts()).every((n) => n === 0)).toBe(true);

    const records = [
      { state: "waiting" as const, createdAt: 10 },
      { state: "waiting" as const, createdAt: 19 },
      { state: "dead" as const, createdAt: 15 },
      { state: "completed" as const, createdAt: 20 },
      { state: "completed" as const, createdAt: 9 },
    ];
    expect(countAddedByScan(records, { from: 10, to: 20 })).toEqual({
      ...emptyAddedCounts(),
      waiting: 2,
      dead: 1,
    });
    // An empty range counts nothing; `into` accumulates.
    expect(countAddedByScan(records, { from: 20, to: 10 })).toEqual(
      emptyAddedCounts(),
    );
    const into = countAddedByScan(records, { from: 0, to: 12 });
    expect(countAddedByScan(records, { from: 12, to: 100 }, into)).toEqual({
      ...emptyAddedCounts(),
      waiting: 2,
      dead: 1,
      completed: 2,
    });
  });

  it("orders by createdAt, then id by code point, and reverses both for desc", () => {
    const jobs = [
      { id: "b", createdAt: 2 },
      { id: "a", createdAt: 2 },
      { id: "B", createdAt: 2 },
      { id: "z", createdAt: 1 },
      // U+10000 sorts after U+FFFF by code point, before it by UTF-16 unit.
      { id: "\u{10000}", createdAt: 3 },
      { id: LAST_BMP, createdAt: 3 },
    ];
    expect(sortByCreated([...jobs], "asc").map((job) => job.id)).toEqual([
      "z",
      "B",
      "a",
      "b",
      LAST_BMP,
      "\u{10000}",
    ]);
    expect(sortByCreated([...jobs], "desc").map((job) => job.id)).toEqual([
      "\u{10000}",
      LAST_BMP,
      "b",
      "a",
      "B",
      "z",
    ]);
    expect(
      compareCreated({ id: "x", createdAt: 1 }, { id: "x", createdAt: 1 }),
    ).toBe(0);
  });

  it("knows the sort and which drivers promise it", () => {
    expect(sortsByCreated({})).toBe(false);
    expect(sortsByCreated({ sort: "natural" })).toBe(false);
    expect(sortsByCreated({ sort: "createdAt" })).toBe(true);
    expect(supportsCreatedSort(new MemoryDriver())).toBe(true);
    expect(supportsCreatedSort(withoutAdded().driver)).toBe(false);
  });
});

describe("countAdded (readApis)", () => {
  it("fills in every state, and the queue asked for even with none", async () => {
    const driver = new MemoryDriver();
    const ns = testNamespace("added-helper");
    await driver.addJobs({ ns, queue: "b" }, [
      makeJob({ id: "b-1", createdAt: T + 1 }),
    ]);
    await driver.addJobs({ ns, queue: "a" }, [
      makeJob({ id: "a-1", createdAt: T + 1 }),
      makeJob({ id: "a-old", createdAt: T - 1 }),
    ]);
    await driver.addJobs({ ns, queue: "c" }, [
      makeJob({ id: "c-old", createdAt: T - 1 }),
    ]);
    const range = { from: T, to: T + 10 };

    const all = await countAdded(driver, ns, range);
    expect(Object.keys(all)).toEqual(["a", "b"]);
    expect(all.a).toEqual({ ...emptyAddedCounts(), waiting: 1 });
    expect(await countAdded(driver, ns, range, "c")).toEqual({
      c: emptyAddedCounts(),
    });
    expect(await countAdded(driver, ns, { from: T, to: T })).toEqual({});
    await driver.close();
  });

  it("refuses a driver without countAddedJobs", async () => {
    const { driver } = withoutAdded();
    await expect(
      countAdded(driver, "ns", { from: 0, to: 1 }),
    ).rejects.toBeInstanceOf(NotSupportedError);
  });
});

describe("queue.list / queue.page with sort", () => {
  it("orders by creation with sort: createdAt, and naturally otherwise", async () => {
    const queue = makeQueue(new MemoryDriver());
    await queue.connect();
    await seedDelayed(queue);

    const ids = async (
      options: Parameters<BunQueue["list"]>[1],
    ): Promise<string[]> =>
      (await queue.list("delayed", options)).map((job) => job.id);

    expect(await ids(undefined)).toEqual(["d-3", "d-1", "d-2"]);
    expect(await ids({ sort: "natural" })).toEqual(["d-3", "d-1", "d-2"]);
    expect(await ids({ sort: "createdAt" })).toEqual(["d-1", "d-2", "d-3"]);
    expect(await ids({ sort: "createdAt", order: "desc", limit: 2 })).toEqual([
      "d-3",
      "d-2",
    ]);

    const page = await queue.page("delayed", {
      sort: "createdAt",
      order: "desc",
      offset: 1,
      limit: 1,
    });
    expect(page.jobs.map((job) => job.id)).toEqual(["d-2"]);
    expect(page.total).toBe(3);
  });

  it("refuses sort: createdAt on a driver without countAddedJobs, before reading", async () => {
    const { driver, seen } = withoutAdded();
    const queue = makeQueue(driver);
    await queue.connect();
    await seedDelayed(queue);

    for (const read of [
      async () => await queue.list("delayed", { sort: "createdAt" }),
      async () => await queue.page("delayed", { sort: "createdAt" }),
      async () =>
        await queue.list("delayed", { sort: "createdAt", search: "d-" }),
    ]) {
      const error = await read().then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).toContain("countAddedJobs");
    }
    expect(seen).toEqual([]);

    // The natural order is still served.
    expect(
      (await queue.list("delayed", { sort: "natural" })).map((job) => job.id),
    ).toEqual(["d-3", "d-1", "d-2"]);
  });

  it("refuses it on the file driver, which does not serve reads by creation", async () => {
    const tmp = await makeTmpDir("added");
    closers.push(tmp.cleanup);
    const queue = makeQueue(new FileDriver({ root: tmp.path }));
    await expect(
      queue.list("delayed", { sort: "createdAt" }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it("refuses a sort it does not know", async () => {
    const queue = makeQueue(new MemoryDriver());
    await expect(
      queue.list("delayed", {
        sort: "runAt" as unknown as "natural",
      }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it("never hands sort: createdAt to a findJobs that does not promise it", async () => {
    const { driver, seen } = withoutAdded();
    const ns = testNamespace("added-gate");
    const q = { ns, queue: "gate" };
    await driver.addJobs(q, [
      makeJob({
        id: "d-2",
        state: "delayed",
        createdAt: T + 2,
        runAt: T + 900,
      }),
      makeJob({
        id: "d-1",
        state: "delayed",
        createdAt: T + 1,
        runAt: T + 500,
      }),
    ]);

    // Below the queue, which would refuse: the page is scanned and sorted,
    // never answered naturally by that findJobs.
    const page = await findJobPage(driver, q, {
      states: ["delayed"],
      offset: 0,
      limit: 10,
      order: "asc",
      sort: "createdAt",
      total: true,
    });
    expect(page.jobs.map((job) => job.id)).toEqual(["d-1", "d-2"]);
    expect(page.total).toBe(2);
    expect(seen).toEqual([]);
  });
});

describe("queue.countAdded", () => {
  it("counts this queue's jobs added in the range, by state", async () => {
    const queue = makeQueue(new MemoryDriver());
    await queue.connect();
    await queue.driver.addJobs(queue.ref, [
      makeJob({ id: "w", createdAt: T }),
      makeJob({
        id: "c",
        state: "completed",
        createdAt: T + 5,
        finishedOn: T + 6,
      }),
      makeJob({ id: "late", createdAt: T + 10 }),
    ]);
    await queue.driver.addJobs({ ns: queue.ref.ns, queue: "elsewhere" }, [
      makeJob({ id: "x", createdAt: T + 1 }),
    ]);

    expect(await queue.countAdded({ from: T, to: T + 10 })).toEqual({
      ...emptyAddedCounts(),
      waiting: 1,
      completed: 1,
    });
    expect(
      await queue.countAdded({ from: new Date(T + 10), to: new Date(T + 11) }),
    ).toEqual({ ...emptyAddedCounts(), waiting: 1 });
    expect(await queue.countAdded({ from: 0, to: 1 })).toEqual(
      emptyAddedCounts(),
    );
  });

  it("refuses a bad or empty range, and a driver without the method", async () => {
    const queue = makeQueue(new MemoryDriver());
    await expect(queue.countAdded({ from: T, to: T })).rejects.toBeInstanceOf(
      ConfigError,
    );
    await expect(
      queue.countAdded({ from: T + 1, to: T }),
    ).rejects.toBeInstanceOf(ConfigError);
    await expect(
      queue.countAdded({ from: Number.NaN, to: T }),
    ).rejects.toBeInstanceOf(ConfigError);
    await expect(
      queue.countAdded({ from: T, to: new Date("nope") }),
    ).rejects.toBeInstanceOf(ConfigError);

    const bare = makeQueue(withoutAdded().driver);
    await expect(bare.countAdded({ from: 0, to: 1 })).rejects.toBeInstanceOf(
      NotSupportedError,
    );
  });
});
