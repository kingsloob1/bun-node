import type { DeadLetter, JobsDriver } from "../lib/index";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import {
  BunJobs,
  BunQueue,
  BunQueueWorker,
  ConfigError,
  MemoryDriver,
} from "../lib/index";
import { testNamespace, waitFor } from "./helpers";

/**
 * Dead jobs: re-driving them in bulk, and routing them to a queue of their own.
 */

/** What these tests' jobs carry: how each one should fail, if at all. */
interface Work {
  /** The message the processor throws with. */
  failWith?: string;
}

const closers: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  await Promise.allSettled(closers.map((close) => close()));
  closers.length = 0;
});

/** A queue and a way to run its jobs to death, on one memory driver. */
function setup(queueName = "work") {
  const driver: JobsDriver = new MemoryDriver();
  const namespace = testNamespace();
  const queue = new BunQueue<Work>(queueName, {
    namespace,
    driver,
    logger: noopLogger,
  });
  closers.push(() => queue.close());

  /** Runs a worker until `dead` jobs have died, then stops it. */
  async function runUntilDead(
    dead: number,
    options: {
      deadLetterQueue?: string;
      watch?: (worker: BunQueueWorker<Work>) => void;
    } = {},
  ) {
    const worker = new BunQueueWorker<Work>(
      queueName,
      async (job) => {
        if (job.data.failWith) {
          throw new Error(job.data.failWith);
        }
        return null;
      },
      {
        namespace,
        driver,
        logger: noopLogger,
        concurrency: 32,
        pollInterval: 2,
        maxBlock: 5,
        deadLetterQueue: options.deadLetterQueue,
      },
    );
    options.watch?.(worker);
    void worker.run();

    await waitFor(async () => (await queue.count("dead")) >= dead, {
      timeout: 15_000,
      message: `fewer than ${dead} jobs died`,
    });

    await worker.close();
  }

  return { driver, namespace, queue, runUntilDead };
}

describe("retryJobs", () => {
  it("returns the listed finished jobs to the queue, and says which went", async () => {
    const { queue, runUntilDead } = setup();
    const a = await queue.add("mail", { failWith: "boom" });
    const b = await queue.add("mail", { failWith: "boom" });
    const c = await queue.add("mail", { failWith: "boom" });
    await runUntilDead(3);

    const announced: string[][] = [];
    queue.on("retried", (ids) => announced.push(ids));

    const retried = await queue.retryJobs([a.id, b.id, "no-such-job"]);

    expect(retried.sort()).toEqual([a.id, b.id].sort());
    expect((await queue.getJob(a.id))?.state).toBe("waiting");
    expect((await queue.getJob(a.id))?.attemptsMade).toBe(0);
    expect((await queue.getJob(c.id))?.state).toBe("dead");
    expect(announced).toEqual([retried]);
  });

  it("keeps attempts when asked not to reset them", async () => {
    const { queue, runUntilDead } = setup();
    const job = await queue.add("mail", { failWith: "boom" }, { attempts: 2 });
    await runUntilDead(1);

    await queue.retryJobs([job.id], { resetAttempts: false });
    expect((await queue.getJob(job.id))?.attemptsMade).toBe(2);
  });
});

describe("retryAll", () => {
  it("re-drives only the jobs whose failure matches", async () => {
    const { queue, runUntilDead } = setup();
    const refused = await queue.add("sync", {
      failWith: "connect ECONNREFUSED 10.0.0.1",
    });
    const timeout = await queue.add("sync", { failWith: "request timed out" });
    const other = await queue.add("mail", { failWith: "ECONNREFUSED again" });
    await runUntilDead(3);

    expect(
      await queue.retryAll("dead", { reason: /ECONNREFUSED/ }),
    ).toHaveLength(2);
    expect((await queue.getJob(timeout.id))?.state).toBe("dead");
    expect((await queue.getJob(refused.id))?.state).toBe("waiting");
    expect((await queue.getJob(other.id))?.state).toBe("waiting");
  });

  it("filters by name, by substring, and by predicate, together", async () => {
    const { queue, runUntilDead } = setup();
    await queue.add("sync", { failWith: "quota exceeded" });
    const wanted = await queue.add("mail", { failWith: "quota exceeded" });
    await queue.add("mail", { failWith: "invalid address" });
    await queue.add("mail", { failWith: "quota exceeded soon" });
    await runUntilDead(4);

    const retried = await queue.retryAll("dead", {
      name: "mail",
      reason: "quota exceeded",
      filter: (job) => job.data.failWith === "quota exceeded",
    });

    expect(retried).toEqual([wanted.id]);
  });

  it("a global pattern matches every job, not every other one", async () => {
    const { queue, runUntilDead } = setup();
    for (let i = 0; i < 4; i++) {
      await queue.add("sync", { failWith: "flaky upstream" });
    }
    await runUntilDead(4);

    expect(await queue.retryAll("dead", { reason: /flaky/g })).toHaveLength(4);
  });

  it("walks past a page of non-matching jobs, and stops at its limit", async () => {
    const { queue, runUntilDead } = setup();
    // More than a page, with the matches spread among the rest.
    for (let i = 0; i < 450; i++) {
      await queue.add("bulk", {
        failWith: i % 3 === 0 ? "retry me" : "leave me",
      });
    }
    await runUntilDead(450);

    expect(await queue.retryAll("dead", { reason: "retry me" })).toHaveLength(
      150,
    );
    expect(await queue.count("dead")).toBe(300);

    expect(await queue.retryAll("dead", { limit: 25 })).toHaveLength(25);
    expect(await queue.count("dead")).toBe(275);
  }, 30_000);

  it("selects nothing by reason among jobs that never failed", async () => {
    const { queue } = setup();
    expect(await queue.retryAll("completed", { reason: "anything" })).toEqual(
      [],
    );
  });
});

describe("dead-letter queues", () => {
  it("files a dead job, as it was, in the queue it names", async () => {
    const { queue, runUntilDead, driver, namespace } = setup();
    const job = await queue.add(
      "charge",
      { failWith: "card declined" },
      { attempts: 2, deadLetter: "failures" },
    );

    const lettered: string[] = [];
    await runUntilDead(1, {
      watch: (worker) =>
        worker.on("deadLettered", (dead, letter) => {
          lettered.push(`${dead.id} -> ${letter.id}`);
        }),
    });

    const failures = new BunQueue<DeadLetter<Work>>("failures", {
      namespace,
      driver,
      logger: noopLogger,
    });
    closers.push(() => failures.close());

    await waitFor(async () => (await failures.count("waiting")) === 1, {
      timeout: 5_000,
      message: "no letter was filed",
    });

    const [letter] = await failures.list("waiting");
    expect(letter!.name).toBe("charge");
    expect(letter!.id).toBe(`work:${job.id}:${job.createdAt}`);
    expect(letter!.data).toMatchObject({
      queue: "work",
      id: job.id,
      name: "charge",
      data: { failWith: "card declined" },
      attemptsMade: 2,
    });
    expect(letter!.data.failedReason.message).toBe("card declined");
    expect(lettered).toEqual([`${job.id} -> ${letter!.id}`]);
    // The dead job is still where it died; retention is its own decision.
    expect((await queue.getJob(job.id))?.state).toBe("dead");
  });

  it("uses the worker's queue for jobs that name none, and the job's own over it", async () => {
    const { queue, runUntilDead, driver, namespace } = setup();
    await queue.add("a", { failWith: "x" });
    await queue.add("b", { failWith: "x" }, { deadLetter: "special" });
    await queue.add("c", { failWith: "x" }, { attempts: 1 });
    await runUntilDead(3, { deadLetterQueue: "graveyard" });

    const count = async (name: string) =>
      new BunQueue(name, { namespace, driver, logger: noopLogger }).count(
        "waiting",
      );

    await waitFor(async () => (await count("graveyard")) === 2, {
      timeout: 5_000,
      message: "the worker's dead-letter queue did not get both letters",
    });
    expect(await count("special")).toBe(1);
  });

  it("files nothing for a job that is retried rather than killed", async () => {
    const { queue, driver, namespace } = setup();
    const worker = new BunQueueWorker<Work>(
      "work",
      async () => {
        throw new Error("try again");
      },
      {
        namespace,
        driver,
        logger: noopLogger,
        pollInterval: 2,
        deadLetterQueue: "graveyard",
      },
    );
    closers.push(() => worker.close({ force: true }));

    const retrying: string[] = [];
    worker.on("retrying", (job) => retrying.push(job.id));
    void worker.run();

    await queue.add("mail", {}, { attempts: 5, backoff: 60_000 });
    await waitFor(() => retrying.length === 1, { timeout: 5_000 });

    const graveyard = new BunQueue("graveyard", {
      namespace,
      driver,
      logger: noopLogger,
    });
    closers.push(() => graveyard.close());
    expect(await graveyard.count("waiting")).toBe(0);
  });

  it("refuses to file a job in the queue it died in", async () => {
    const { queue, runUntilDead } = setup();
    await queue.add("loop", { failWith: "x" }, { deadLetter: "work" });

    const errors: string[] = [];
    await runUntilDead(1, {
      watch: (worker) =>
        worker.on("error", (error, context) => {
          errors.push(`${context}: ${error.message}`);
        }),
    });

    expect(errors.some((line) => line.startsWith("deadLetter:"))).toBe(true);
    expect(await queue.count("waiting")).toBe(0);
  });

  it("rejects a dead-letter name that is not a valid queue name", async () => {
    const { queue } = setup();
    await expect(
      queue.add("mail", {}, { deadLetter: "not a:valid/name" }),
    ).rejects.toThrow(ConfigError);
  });

  it("is available on the builder and through withOptions", async () => {
    const jobs = new BunJobs({
      namespace: testNamespace(),
      driver: new MemoryDriver(),
      logger: noopLogger,
    });
    closers.push(() => jobs.close());
    jobs.define("charge", async () => null);

    const chained = await jobs.run("charge").deadLetter("failures").start();
    const described = await jobs
      .run("charge")
      .withOptions({ deadLetter: "failures" })
      .start();

    expect(chained.opts.deadLetter).toBe("failures");
    expect(described.opts.deadLetter).toBe("failures");
    // Absent, not undefined, for a job that names none.
    expect("deadLetter" in (await jobs.now("charge")).opts).toBe(false);
  });
});
