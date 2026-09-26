import type { DriverConfig, JobsDriver, QueueRef } from "../lib/index";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { BunQueue, BunQueueWorker, createDriver } from "../lib/index";
import { testNamespace, waitFor } from "./helpers";
import { crossProcessBackends } from "./helpers/backends";

/**
 * A refused failure write is this attempt's failure only on evidence (#194).
 *
 * When the driver refuses a worker's failure write, the worker used to read
 * the job back and take a job that was **gone** as proof its own failure had
 * landed and retention removed it. But a job is also gone when the attempt
 * that recovered it completed it under `removeOnComplete`, and the worker then
 * announced `failed` and `dead`, and filed a dead letter, for a job that
 * completed.
 *
 * Every driver checks the lock and writes in one atomic step, so a refusal is
 * the whole truth unless a try before it threw. And even then a gone job is
 * ours only when our write's own retention could have removed it.
 *
 * **How it is made certain.** The first attempt expires its own lock and waits;
 * the stalled sweep hands the job back, the recovering attempt completes it
 * and completion retention removes it; only once the job is gone is the first
 * attempt let throw. Every step waits on an event or a read, never a guessed
 * duration; the end is `close()`, which waits for the failure path — dead
 * letter included — to finish.
 *
 * **The control** is the case the old reading protected: the failure write
 * lands, its reply is lost, `removeOnFail` removes the job and the retry is
 * refused. That is still reported, once.
 */

/** Longest any gate may hold, so a broken scenario fails instead of hanging. */
const GATE_MS = 10_000;
/** The queue under test. */
const QUEUE = "landed";
/** Where the workers file dead letters. */
const DLQ = "landed-dlq";
/** The events a test watches, on the workers and on the wire. */
const OUTCOMES = [
  "completed",
  "failed",
  "dead",
  "retrying",
  "lockLost",
] as const;

/**
 * What `crossProcessBackends` registers — its temp directories — released once
 * the file ends. Each test's own driver is closed by `closers`, at its end.
 */
const backendCleanups: (() => Promise<void>)[] = [];

afterAll(async () => {
  await Promise.allSettled(backendCleanups.map((cleanup) => cleanup()));
});

const closers: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close().catch(() => undefined);
  }
});

/** Memory, the file driver, SQLite and every configured server. */
const BACKENDS: { name: string; config: DriverConfig; available: boolean }[] = [
  { name: "memory", config: { type: "memory" }, available: true },
  ...(await crossProcessBackends({ cleanups: backendCleanups })),
];

/** A promise and the function that resolves it. */
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** Waits for `promise`, failing with `what` after {@link GATE_MS}. */
async function within<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${what}`)),
      GATE_MS,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A driver for `config`, closed at the end of the test, whose published queue
 * events are recorded as the workers send them — no subscriber, so nothing to
 * wait on for an event that should never come.
 */
function setup(config: DriverConfig) {
  const driver = createDriver(config);
  const namespace = testNamespace("failure-landed");
  // Registered first, so it runs after the worker and queue closers.
  closers.push(async () => {
    await driver.purge(namespace).catch(() => undefined);
    await driver.close();
  });

  /** Every outcome event published for the queue, in order. */
  const published: string[] = [];
  const publish = driver.publish.bind(driver);
  driver.publish = async (event) => {
    if (
      event.kind === "queue" &&
      event.target === QUEUE &&
      (OUTCOMES as readonly string[]).includes(event.type)
    ) {
      published.push(event.type);
    }
    await publish(event);
  };

  const queue = new BunQueue(QUEUE, { namespace, driver, logger: noopLogger });
  const letters = new BunQueue(DLQ, { namespace, driver, logger: noopLogger });
  closers.push(() => queue.close());
  closers.push(() => letters.close());

  /** How many dead letters were filed. */
  const deadLetters = async () =>
    Object.values(await letters.count()).reduce((sum, n) => sum + n, 0);

  return { driver, namespace, queue, published, deadLetters };
}

/** A worker's events, as `<label> <event>`, appended to `heard`. */
function listen<TResult>(
  worker: BunQueueWorker<unknown, TResult>,
  label: string,
  heard: string[],
) {
  for (const event of OUTCOMES) {
    worker.on(event, () => {
      heard.push(`${label} ${event}`);
    });
  }
}

/**
 * The issue's scenario: the first attempt's lock lapses, the stalled sweep
 * hands the job back, a second attempt claims it and completes it, completion
 * retention removes it — and only then does the first attempt throw.
 *
 * With `workers: 1` both attempts run on one worker at concurrency 2; with
 * `workers: 2` the job is recovered by a second worker.
 */
async function completedElsewhere(
  config: DriverConfig,
  options: {
    /** One worker at concurrency 2, or two at concurrency 1. */
    workers: 1 | 2;
    /** The job's attempts: 1 fails it for good, more retries it. */
    attempts: number;
    /**
     * Makes the first try of the failure write throw without writing: a
     * connection that failed before the request left.
     */
    firstFailWriteThrows?: boolean;
  },
) {
  const { driver, namespace, queue, published, deadLetters } = setup(config);
  const ref: QueueRef = queue.ref;
  const firstStarted = gate();
  const releaseFirst = gate();
  /** Tries of the failure write, the thrown one included. */
  const failTries = { count: 0 };

  const failJob = driver.failJob.bind(driver);
  const counted: JobsDriver["failJob"] = async (...args) => {
    failTries.count++;
    if (options.firstFailWriteThrows && failTries.count === 1) {
      throw new Error("Connection refused: the write never left");
    }
    return await failJob(...args);
  };
  driver.failJob = counted;

  const processor = async (job: {
    id: string;
    stalledCount: number;
    lockToken: string | null;
  }) => {
    if (job.stalledCount > 0) {
      return "the recovered attempt";
    }

    // Our own lock, lapsed now: the next stalled sweep hands the job back
    // while this attempt is still running.
    await driver.extendJobLock(ref, job.id, job.lockToken!, 0, Date.now());
    firstStarted.open();
    await within(releaseFirst.promise, "the test to release the first attempt");
    throw new Error("the first attempt, failing late");
  };

  const workerOptions = {
    namespace,
    driver,
    logger: noopLogger,
    // Long: nothing renews or expires a lock but the test.
    lockDuration: 60_000,
    heartbeatInterval: 30_000,
    stalledInterval: 20,
    pollInterval: 5,
    maintenance: false,
    publish: true,
    deadLetterQueue: DLQ,
  };

  const heard: string[] = [];
  const first = new BunQueueWorker(QUEUE, processor, {
    ...workerOptions,
    concurrency: options.workers === 1 ? 2 : 1,
  });
  closers.push(() => first.close({ force: true }));
  listen(first, "first", heard);
  const workers = [first];
  void first.run();

  const job = await queue.add(
    "x",
    {},
    { attempts: options.attempts, removeOnComplete: true },
  );
  await within(firstStarted.promise, "the first attempt");

  if (options.workers === 2) {
    // Started only now, so the first worker is the one that claimed first; at
    // concurrency 1 and busy, it cannot claim the job back itself.
    const second = new BunQueueWorker(QUEUE, processor, {
      ...workerOptions,
      concurrency: 1,
    });
    closers.push(() => second.close({ force: true }));
    listen(second, "second", heard);
    workers.push(second);
    void second.run();
  }

  const recoverer = options.workers === 1 ? "first" : "second";
  await waitFor(() => heard.includes(`${recoverer} completed`), {
    timeout: GATE_MS,
    message: () => `the job was never completed: ${JSON.stringify(heard)}`,
  });
  await waitFor(async () => (await driver.getJob(ref, job.id)) === null, {
    timeout: GATE_MS,
    message: "completion retention never removed the job",
  });

  releaseFirst.open();
  await waitFor(
    () =>
      heard.some(
        (line) =>
          line === "first lockLost" ||
          line === "first dead" ||
          line === "first retrying",
      ),
    {
      timeout: GATE_MS,
      message: () =>
        `the first attempt's end was never reported: ${JSON.stringify(heard)}`,
    },
  );
  // Waits for the failure path to finish — its dead letter and its publishes
  // included — so an absence below is final.
  for (const worker of workers) {
    await worker.close();
  }

  return {
    heard: heard.toSorted(),
    published: published.toSorted(),
    deadLetters: await deadLetters(),
    failTries: failTries.count,
    job: await driver.getJob(ref, job.id),
  };
}

for (const { name, config, available } of BACKENDS) {
  describe.skipIf(!available)(`a refused failure write: ${name}`, () => {
    it("reports a lost lock, not a failure, when the recovering attempt completed the job and retention removed it", async () => {
      const outcome = await completedElsewhere(config, {
        workers: 1,
        attempts: 1,
      });

      expect(outcome.job).toBeNull();
      expect(outcome.heard).toEqual(["first completed", "first lockLost"]);
      expect(outcome.published).toEqual(["completed"]);
      expect(outcome.deadLetters).toBe(0);
    });

    it("reports a lost lock when another worker recovered and completed the job", async () => {
      const outcome = await completedElsewhere(config, {
        workers: 2,
        attempts: 1,
      });

      expect(outcome.job).toBeNull();
      expect(outcome.heard).toEqual(["first lockLost", "second completed"]);
      expect(outcome.published).toEqual(["completed"]);
      expect(outcome.deadLetters).toBe(0);
    });

    it("reports a lost lock, not a retry, when attempts remain", async () => {
      const outcome = await completedElsewhere(config, {
        workers: 1,
        attempts: 3,
      });

      expect(outcome.job).toBeNull();
      expect(outcome.heard).toEqual(["first completed", "first lockLost"]);
      expect(outcome.published).toEqual(["completed"]);
      expect(outcome.deadLetters).toBe(0);
    });

    it("reports a lost lock when the first failure write threw and the job is gone without our retention", async () => {
      // A try threw, so the read-back runs — but `removeOnFail` is off, so our
      // write could not have removed the job, and a gone job is not ours.
      const outcome = await completedElsewhere(config, {
        workers: 1,
        attempts: 1,
        firstFailWriteThrows: true,
      });

      expect(outcome.failTries).toBeGreaterThanOrEqual(2);
      expect(outcome.job).toBeNull();
      expect(outcome.heard).toEqual(["first completed", "first lockLost"]);
      expect(outcome.published).toEqual(["completed"]);
      expect(outcome.deadLetters).toBe(0);
    });

    /**
     * A worker whose first failure write lands and then throws, as a reply
     * lost on the way back would, and whose processor always fails.
     */
    async function lostReply(removeOnFail: boolean) {
      const { driver, namespace, queue, published, deadLetters } =
        setup(config);
      const tries = { count: 0 };
      const failJob = driver.failJob.bind(driver);
      const losing: JobsDriver["failJob"] = async (...args) => {
        tries.count++;
        const landed = await failJob(...args);
        if (tries.count === 1) {
          expect(landed).toBe(true);
          throw new Error("Connection reset: the reply never came");
        }
        return landed;
      };
      driver.failJob = losing;

      const heard: string[] = [];
      const worker = new BunQueueWorker(
        QUEUE,
        async () => {
          throw new Error("the job's own failure");
        },
        {
          namespace,
          driver,
          logger: noopLogger,
          lockDuration: 60_000,
          heartbeatInterval: 30_000,
          pollInterval: 5,
          maintenance: false,
          publish: true,
          deadLetterQueue: DLQ,
        },
      );
      closers.push(() => worker.close({ force: true }));
      listen(worker, "worker", heard);
      void worker.run();

      const job = await queue.add("x", {}, { attempts: 1, removeOnFail });
      await waitFor(
        () =>
          heard.includes("worker dead") || heard.includes("worker lockLost"),
        {
          timeout: GATE_MS,
          message: () =>
            `the failure was never reported: ${JSON.stringify(heard)}`,
        },
      );
      await worker.close();

      return {
        tries: tries.count,
        heard: heard.toSorted(),
        published: published.toSorted(),
        deadLetters: await deadLetters(),
        job: await driver.getJob(queue.ref, job.id),
      };
    }

    it("control: still reports its own failure once when the write landed, its reply was lost and removeOnFail removed the job", async () => {
      const outcome = await lostReply(true);

      expect(outcome.tries).toBe(2);
      expect(outcome.job).toBeNull();
      expect(outcome.heard).toEqual(["worker dead", "worker failed"]);
      expect(outcome.published).toEqual(["dead", "failed"]);
      expect(outcome.deadLetters).toBe(1);
    });

    it("still reports its own failure once when the write landed and its reply was lost, the job kept", async () => {
      const outcome = await lostReply(false);

      expect(outcome.tries).toBe(2);
      expect(outcome.job?.state).toBe("dead");
      expect(outcome.job?.failedReason?.message).toBe("the job's own failure");
      expect(outcome.heard).toEqual(["worker dead", "worker failed"]);
      expect(outcome.published).toEqual(["dead", "failed"]);
      expect(outcome.deadLetters).toBe(1);
    });
  });
}
