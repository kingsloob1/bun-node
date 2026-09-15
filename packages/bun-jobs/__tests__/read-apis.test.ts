import type { JobsDriver, PendingThroughput, WorkerInfo } from "../lib/index";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  BunJobs,
  BunQueue,
  BunQueueWorker,
  ConfigError,
  HOST,
  MemoryDriver,
  NotSupportedError,
  registerWorkerRecord,
  SqlDriver,
  THROUGHPUT_BUCKET_MS,
  throughputBucket,
  ThroughputBuffer,
} from "../lib/index";
import { makeTmpDir, testNamespace, waitFor } from "./helpers";

/**
 * The read APIs a management UI needs, through the queue, the worker and the
 * context rather than the driver — the driver contract covers each backend's
 * half in `helpers/driverContract.ts`.
 */

/** Closed after each test, in reverse order of creation. */
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (closers.length > 0) {
    await closers.pop()!().catch(() => undefined);
  }
});

/** A driver with some optional methods hidden, as an older driver would be. */
function without(
  driver: JobsDriver,
  methods: (keyof JobsDriver)[],
): JobsDriver {
  return new Proxy(driver, {
    get(target, property) {
      if (methods.includes(property as keyof JobsDriver)) {
        return undefined;
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** A queue on `driver`, closed after the test. */
function makeQueue(
  driver: JobsDriver,
  name = "work",
  namespace = testNamespace("read"),
): BunQueue {
  const queue = new BunQueue(name, { namespace, driver });
  closers.push(async () => await queue.close());
  return queue;
}

/** A running worker on a queue, closed after the test. */
function startWorker(
  queue: BunQueue,
  processor: ConstructorParameters<typeof BunQueueWorker>[1],
  options: Partial<ConstructorParameters<typeof BunQueueWorker>[2]> = {},
): BunQueueWorker {
  const worker = new BunQueueWorker(queue.name, processor, {
    namespace: queue.namespace,
    driver: queue.driver,
    pollInterval: 10,
    ...options,
  });
  closers.push(async () => await worker.close({ timeout: 1_000 }));
  void worker.run();
  return worker;
}

describe("queue.list and queue.page", () => {
  for (const [label, strip] of [
    ["native", [] as (keyof JobsDriver)[]],
    ["fallback", ["findJobs"] as (keyof JobsDriver)[]],
  ] as const) {
    it(`${label}: narrows by name and search, and pages with a total`, async () => {
      const driver = without(new MemoryDriver(), [...strip]);
      const queue = makeQueue(driver);

      for (let index = 0; index < 12; index++) {
        await queue.add(
          index % 3 === 0 ? "sendEmail" : "resize",
          { index },
          {
            jobId: `job-${String(index).padStart(2, "0")}`,
          },
        );
      }

      const emails = await queue.list("waiting", { name: "sendEmail" });
      expect(emails.map((job) => job.id)).toEqual([
        "job-00",
        "job-03",
        "job-06",
        "job-09",
      ]);

      expect(
        (
          await queue.list("waiting", {
            name: ["sendEmail", "resize"],
            limit: 2,
          })
        ).length,
      ).toBe(2);
      expect(await queue.list("waiting", { name: [] })).toEqual([]);

      const searched = await queue.list("waiting", { search: "JOB-1" });
      expect(searched.map((job) => job.id)).toEqual(["job-10", "job-11"]);

      const page = await queue.page("waiting", {
        name: "resize",
        offset: 2,
        limit: 3,
      });
      expect(page.total).toBe(8);
      expect(page.jobs.map((job) => job.id)).toEqual([
        "job-04",
        "job-05",
        "job-07",
      ]);

      const unfiltered = await queue.page(["waiting", "completed"], {
        limit: 5,
      });
      expect(unfiltered.total).toBe(12);
      expect(unfiltered.jobs).toHaveLength(5);

      expect(await queue.page("waiting", { search: "nope" })).toEqual({
        jobs: [],
        total: 0,
      });
    });
  }

  it("fallback: pages a filtered read across the scan's chunks exactly as the driver does", async () => {
    const native = makeQueue(new MemoryDriver());
    const fallback = makeQueue(without(new MemoryDriver(), ["findJobs"]));
    // More than two of the fallback's 500-job reads, one match in three.
    const entries = Array.from({ length: 1_203 }, (_, index) => ({
      name: index % 3 === 0 ? "keep" : "skip",
      data: {},
      opts: { jobId: `j-${String(index).padStart(4, "0")}` },
    }));
    await native.addBulk(entries);
    await fallback.addBulk(entries);

    for (const [offset, limit] of [
      [0, 10],
      [160, 20],
      [166, 1],
      [395, 20],
      [401, 5],
    ] as const) {
      const expected = await native.page("waiting", {
        name: "keep",
        offset,
        limit,
      });
      const actual = await fallback.page("waiting", {
        name: "keep",
        offset,
        limit,
      });

      expect(expected.total).toBe(401);
      expect(actual.total).toBe(401);
      expect(actual.jobs.map((job) => job.id)).toEqual(
        expected.jobs.map((job) => job.id),
      );
    }

    // Without a total, a page that starts in a later chunk.
    const deep = await fallback.list("waiting", {
      name: "keep",
      offset: 300,
      limit: 3,
    });
    expect(deep.map((job) => job.id)).toEqual(["j-0900", "j-0903", "j-0906"]);
  });

  it("counts the total by scan when a driver's findJobs answers without one", async () => {
    const driver = new MemoryDriver();
    const findJobs = driver.findJobs.bind(driver);
    driver.findJobs = async (q, query) => ({
      jobs: (await findJobs(q, query)).jobs,
    });
    const queue = makeQueue(driver);

    for (let index = 0; index < 5; index++) {
      await queue.add("a", {});
    }
    await queue.add("b", {});

    const page = await queue.page("waiting", { name: "a", limit: 2 });
    expect(page.jobs).toHaveLength(2);
    expect(page.total).toBe(5);
  });

  it("leaves an unfiltered list on the driver's listJobs, as it always was", async () => {
    const driver = new MemoryDriver();
    const queue = makeQueue(driver);
    await queue.add("a", {});

    let found = 0;
    const findJobs = driver.findJobs.bind(driver);
    driver.findJobs = async (...args) => {
      found++;
      return await findJobs(...args);
    };

    await queue.list("waiting");
    expect(found).toBe(0);

    await queue.list("waiting", { search: "x" });
    expect(found).toBe(1);
  });
});

describe("queue.getJobs", () => {
  for (const [label, strip] of [
    ["native", [] as (keyof JobsDriver)[]],
    ["fallback", ["getJobs"] as (keyof JobsDriver)[]],
  ] as const) {
    it(`${label}: answers in the order asked, null for a missing id`, async () => {
      const queue = makeQueue(without(new MemoryDriver(), [...strip]));
      await queue.add("a", { n: 1 }, { jobId: "one" });
      await queue.add("b", { n: 2 }, { jobId: "two" });

      const jobs = await queue.getJobs(["two", "missing", "one", "two"]);

      expect(jobs.map((job) => job?.id ?? null)).toEqual([
        "two",
        null,
        "one",
        "two",
      ]);
      expect(jobs[2]?.data).toEqual({ n: 1 });
      expect(await queue.getJobs([])).toEqual([]);
    });
  }
});

describe("queue.listWorkers", () => {
  for (const [label, strip] of [
    ["native", [] as (keyof JobsDriver)[]],
    [
      "queue-state fallback",
      ["registerWorker", "removeWorker", "listWorkers"] as (keyof JobsDriver)[],
    ],
  ] as const) {
    it(`${label}: lists a running worker, follows its pause and concurrency, and forgets it on close`, async () => {
      const queue = makeQueue(without(new MemoryDriver(), [...strip]));
      const release = Promise.withResolvers<void>();
      const worker = startWorker(queue, async () => await release.promise, {
        id: "worker-a",
        concurrency: 3,
      });

      await waitFor(async () => (await queue.listWorkers()).length === 1);
      const [listed] = await queue.listWorkers();

      expect(listed).toMatchObject({
        id: "worker-a",
        queue: queue.name,
        host: HOST,
        pid: process.pid,
        concurrency: 3,
        active: 0,
        paused: false,
      } satisfies Partial<WorkerInfo>);
      expect(listed!.expiresAt).toBe(listed!.heartbeatAt + 30_000);
      expect(listed!.startedAt).toBeLessThanOrEqual(listed!.heartbeatAt);

      await queue.add("slow", {});
      await waitFor(() => worker.activeCount === 1);

      await worker.pause();
      await waitFor(
        async () => (await queue.listWorkers())[0]?.paused === true,
      );
      // The pause's report was written with the job still in flight.
      expect((await queue.listWorkers())[0]?.active).toBe(1);

      worker.concurrency = 5;
      await waitFor(
        async () => (await queue.listWorkers())[0]?.concurrency === 5,
      );

      worker.resume();
      await waitFor(
        async () => (await queue.listWorkers())[0]?.paused === false,
      );

      release.resolve();
      await worker.close();
      expect(await queue.listWorkers()).toEqual([]);
    });
  }

  it("refreshes the heartbeat on the report interval", async () => {
    const queue = makeQueue(new MemoryDriver());
    startWorker(queue, async () => undefined, { reportInterval: 40 });

    await waitFor(async () => (await queue.listWorkers()).length === 1);
    const first = (await queue.listWorkers())[0]!;

    await waitFor(
      async () =>
        ((await queue.listWorkers())[0]?.heartbeatAt ?? 0) > first.heartbeatAt,
      { timeout: 2_000 },
    );
    const later = (await queue.listWorkers())[0]!;
    expect(later.startedAt).toBe(first.startedAt);
    expect(later.expiresAt).toBe(later.heartbeatAt + 120);
  });

  it("stops listing a worker whose record lapsed without it closing", async () => {
    const queue = makeQueue(new MemoryDriver());
    await queue.connect();
    const now = Date.now();

    await registerWorkerRecord(queue.driver, queue.ref, {
      id: "crashed",
      queue: queue.name,
      host: "elsewhere",
      pid: 1,
      concurrency: 1,
      active: 1,
      paused: false,
      startedAt: now - 60_000,
      heartbeatAt: now - 40_000,
      expiresAt: now + 60,
    });

    expect((await queue.listWorkers()).map((worker) => worker.id)).toEqual([
      "crashed",
    ]);
    await Bun.sleep(80);
    expect(await queue.listWorkers()).toEqual([]);
  });

  it("writes no heartbeat per job — only on start, and on its interval", async () => {
    const driver = new MemoryDriver();
    const queue = makeQueue(driver);

    let writes = 0;
    const registerWorker = driver.registerWorker.bind(driver);
    driver.registerWorker = async (...args) => {
      writes++;
      await registerWorker(...args);
    };

    await queue.addBulk(
      Array.from({ length: 200 }, (_, index) => ({
        name: "n",
        data: { index },
      })),
    );
    startWorker(queue, async () => undefined, { concurrency: 8 });

    await waitFor(async () => (await queue.count("completed")) === 200, {
      timeout: 5_000,
    });
    expect(writes).toBe(1);
  });

  it("does not report with reportInterval 0, and rejects a negative one", async () => {
    const queue = makeQueue(new MemoryDriver());
    const worker = startWorker(queue, async () => undefined, {
      reportInterval: 0,
    });

    await waitFor(() => worker.isRunning);
    await Bun.sleep(20);
    expect(await queue.listWorkers()).toEqual([]);

    expect(
      () =>
        new BunQueueWorker(queue.name, async () => undefined, {
          namespace: queue.namespace,
          driver: queue.driver,
          reportInterval: -1,
        }),
    ).toThrow(ConfigError);
  });

  it("says so when the driver can keep no worker records", async () => {
    const queue = makeQueue(
      without(new MemoryDriver(), [
        "registerWorker",
        "removeWorker",
        "listWorkers",
        "getQueueState",
        "setQueueState",
        "listQueueState",
      ]),
    );

    await expect(queue.listWorkers()).rejects.toThrow(NotSupportedError);

    // The context answers the same way, rather than with an empty list that
    // reads as "no workers".
    const jobs = new BunJobs({
      namespace: queue.namespace,
      driver: queue.driver,
    });
    closers.push(async () => await jobs.close());
    await queue.add("n", {});
    await expect(jobs.listWorkers()).rejects.toThrow(NotSupportedError);
  });
});

describe("queue.getThroughput", () => {
  it("counts what workers complete and fail, a minute per bucket", async () => {
    const queue = makeQueue(new MemoryDriver());

    for (let index = 0; index < 5; index++) {
      await queue.add(index < 3 ? "ok" : "bad", {});
    }

    startWorker(
      queue,
      async (job) => {
        if (job.name === "bad") {
          throw new Error("no");
        }
        return "done";
      },
      { concurrency: 5 },
    );

    await waitFor(
      async () =>
        (await queue.count("completed")) === 3 &&
        (await queue.count("dead")) === 2,
    );

    const throughput = await queue.getThroughput({ minutes: 5 });

    expect(throughput.interval).toBe(THROUGHPUT_BUCKET_MS);
    expect(throughput.buckets).toHaveLength(5);
    expect(throughput.to).toBe(throughput.buckets.at(-1)!.at);
    expect(throughput.from).toBe(throughput.buckets[0]!.at);
    expect(throughput.to - throughput.from).toBe(4 * THROUGHPUT_BUCKET_MS);
    expect(
      throughput.buckets.every(
        (bucket, index) =>
          index === 0 ||
          bucket.at - throughput.buckets[index - 1]!.at ===
            THROUGHPUT_BUCKET_MS,
      ),
    ).toBe(true);
    expect(throughput.completed).toBe(3);
    expect(throughput.failed).toBe(2);
    expect(
      throughput.buckets.reduce((sum, bucket) => sum + bucket.completed, 0),
    ).toBe(3);
  });

  it("fills minutes with nothing in them, and leaves out minutes outside the window", async () => {
    const driver = new MemoryDriver();
    const queue = makeQueue(driver);
    await queue.connect();

    const current = throughputBucket(Date.now());
    const token = "t";

    for (const [id, at] of [
      ["old", current - 10 * THROUGHPUT_BUCKET_MS],
      ["recent", current - 2 * THROUGHPUT_BUCKET_MS],
    ] as const) {
      await queue.add("n", {}, { jobId: id });
      await driver.claimJob(queue.ref, {
        workerId: "w",
        token,
        lockMs: 60_000,
        now: Date.now(),
      });
      await driver.completeJob(queue.ref, id, token, null, false, at);
    }

    const { buckets, completed } = await queue.getThroughput({ minutes: 3 });
    expect(buckets.map((bucket) => bucket.completed)).toEqual([1, 0, 0]);
    expect(buckets[0]!.at).toBe(current - 2 * THROUGHPUT_BUCKET_MS);
    expect(completed).toBe(1);
  });

  it("checks minutes, and says so when the driver keeps no counts", async () => {
    const queue = makeQueue(new MemoryDriver());

    for (const minutes of [0, 1.5, 1441, Number.NaN]) {
      await expect(queue.getThroughput({ minutes })).rejects.toThrow(
        ConfigError,
      );
    }
    expect((await queue.getThroughput({ minutes: 1440 })).buckets).toHaveLength(
      1440,
    );

    const bare = makeQueue(without(new MemoryDriver(), ["getThroughput"]));
    await expect(bare.getThroughput()).rejects.toThrow(ConfigError);
  });
});

describe("BunJobs aggregates", () => {
  for (const [label, strip] of [
    ["native", [] as (keyof JobsDriver)[]],
    ["fallback", ["countJobsByQueue"] as (keyof JobsDriver)[]],
  ] as const) {
    it(`${label}: summarises every queue in the namespace, and nothing outside it`, async () => {
      const driver = without(new MemoryDriver(), [...strip]);
      const namespace = testNamespace("summary");
      const jobs = new BunJobs({ namespace, driver });
      closers.push(async () => await jobs.close());
      const neighbour = new BunJobs({
        namespace: testNamespace("other"),
        driver,
      });
      closers.push(async () => await neighbour.close());

      await jobs.queue("mail").add("send", {});
      await jobs.queue("mail").add("send", {}, { delay: 60_000 });
      await jobs.queue("images").add("resize", {});
      await jobs.queue("images").pause();
      await neighbour.queue("mail").add("send", {});

      const summaries = await jobs.getQueueSummaries();

      expect(summaries.map((summary) => summary.name)).toEqual([
        "images",
        "mail",
      ]);
      expect(summaries[0]).toMatchObject({ total: 1, paused: true });
      expect(summaries[0]!.counts.waiting).toBe(1);
      expect(summaries[1]).toMatchObject({ total: 2, paused: false });
      expect(summaries[1]!.counts).toMatchObject({ waiting: 1, delayed: 1 });
    });
  }

  it("lists the workers of every queue in the namespace", async () => {
    const driver = new MemoryDriver();
    const jobs = new BunJobs({ namespace: testNamespace("workers"), driver });
    closers.push(async () => await jobs.close());

    const mail = jobs.worker("mail", async () => undefined, { id: "m1" });
    const images = jobs.worker("images", async () => undefined, { id: "i1" });
    void mail.run();
    void images.run();

    await waitFor(async () => (await jobs.listWorkers()).length === 2);
    expect(
      (await jobs.listWorkers()).map((worker) => [worker.queue, worker.id]),
    ).toEqual([
      ["images", "i1"],
      ["mail", "m1"],
    ]);
  });
});

describe("closing writes gathered throughput, whoever owns the driver", () => {
  /** A SQLite driver on a fresh file, closed after the test. */
  async function sharedSqlite(): Promise<{ driver: SqlDriver; path: string }> {
    const tmp = await makeTmpDir("bun-jobs-read-flush");
    const path = join(tmp.path, "jobs.db");
    const driver = new SqlDriver({ url: `sqlite://${path}` });
    closers.push(async () => {
      await driver.close();
      await tmp.cleanup();
    });
    return { driver, path };
  }

  /** What another process reads back: completions since `since`. */
  async function completedSince(
    path: string,
    queue: BunQueue,
    since: number,
  ): Promise<number> {
    const reader = new SqlDriver({ url: `sqlite://${path}` });
    try {
      const buckets = await reader.getThroughput(queue.ref, {
        from: throughputBucket(since),
        to: throughputBucket(Date.now()),
      });
      return buckets.reduce((sum, bucket) => sum + bucket.completed, 0);
    } finally {
      await reader.close();
    }
  }

  it("a worker writes them when it closes, on a driver it does not own", async () => {
    const since = Date.now();
    const { driver, path } = await sharedSqlite();
    const queue = makeQueue(driver, "flush-worker");
    await queue.add("n", {});

    const worker = startWorker(queue, async () => "ok");
    await waitFor(async () => (await queue.count("completed")) === 1);
    await worker.close();

    expect(await completedSince(path, queue, since)).toBe(1);
  });

  it("a queue writes them when it closes, on a driver it does not own", async () => {
    const since = Date.now();
    const { driver, path } = await sharedSqlite();
    const queue = makeQueue(driver, "flush-queue");
    await queue.add("n", {}, { jobId: "j" });

    const now = Date.now();
    await driver.claimJob(queue.ref, {
      workerId: "w",
      token: "t",
      lockMs: 60_000,
      now,
    });
    expect(
      await driver.completeJob(queue.ref, "j", "t", null, false, now),
    ).toBe(true);
    await queue.close();

    expect(await completedSince(path, queue, since)).toBe(1);
  });
});

describe("closing a worker that never reported", () => {
  it("touches nothing when it never ran", async () => {
    const driver = new MemoryDriver();
    let removes = 0;
    let connects = 0;
    const removeWorker = driver.removeWorker.bind(driver);
    driver.removeWorker = async (...args) => {
      removes++;
      return await removeWorker(...args);
    };
    const connect = driver.connect.bind(driver);
    driver.connect = async () => {
      connects++;
      await connect();
    };

    const worker = new BunQueueWorker("idle", async () => undefined, {
      namespace: testNamespace("never-ran"),
      driver,
    });
    await worker.close();

    expect({ removes, connects }).toEqual({ removes: 0, connects: 0 });
  });

  it("closes promptly, removing nothing, after run() failed to connect", async () => {
    const driver = new MemoryDriver();
    let removes = 0;
    driver.removeWorker = async () => {
      removes++;
      return false;
    };
    driver.connect = async () => {
      throw new Error("unreachable");
    };

    const worker = new BunQueueWorker("down", async () => undefined, {
      namespace: testNamespace("unreachable"),
      driver,
    });
    await expect(worker.run()).rejects.toThrow("unreachable");

    const outcome = await Promise.race([
      worker.close().then(() => "closed"),
      Bun.sleep(2_000).then(() => "hung"),
    ]);
    expect(outcome).toBe("closed");
    expect(worker.isRunning).toBe(false);
    expect(removes).toBe(0);
  });
});

describe("ThroughputBuffer", () => {
  const q = { ns: "n", queue: "q" };

  it("puts back only the counts a write did not land", async () => {
    const written: string[][] = [];
    let first = true;
    const buffer = new ThroughputBuffer(async (batch: PendingThroughput[]) => {
      written.push(
        batch.map(
          (entry) => `${entry.q.queue}:${entry.completed}:${entry.failed}`,
        ),
      );
      if (first) {
        first = false;
        return {
          unwritten: batch.filter((entry) => entry.q.queue === "q2"),
          error: new Error("q2 was refused"),
        };
      }
      return { unwritten: [] };
    });

    buffer.add(q, 0, 1, 0);
    buffer.add({ ns: "n", queue: "q2" }, 0, 0, 1);
    // The refusal reaches the caller, and only the refused count goes back.
    await expect(buffer.flush()).rejects.toThrow("q2 was refused");
    await buffer.flush();
    await buffer.close();

    expect(written).toEqual([["q:1:0", "q2:0:1"], ["q2:0:1"]]);
  });

  it("resolves a write that landed everything", async () => {
    let calls = 0;
    const buffer = new ThroughputBuffer(async () => {
      calls++;
      return { unwritten: [] };
    });

    buffer.add(q, 0, 1, 0);
    await expect(buffer.flush()).resolves.toBeUndefined();
    await buffer.flush();
    await buffer.close();
    expect(calls).toBe(1);
  });

  it("gives each caller its own outcome, not another caller's error", async () => {
    let calls = 0;
    const buffer = new ThroughputBuffer(async () => {
      calls++;
      await Bun.sleep(10);
      if (calls === 1) {
        throw new Error("the first write failed");
      }
      return { unwritten: [] };
    });

    buffer.add(q, 0, 1, 0);
    const first = buffer.flush();
    const second = buffer.flush();

    await expect(first).rejects.toThrow("the first write failed");
    await expect(second).resolves.toBeUndefined();
    // The second caller wrote what the first put back.
    expect(calls).toBe(2);
    await buffer.close();
  });
});
