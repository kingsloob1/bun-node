import type { LogEvent, StandardSchemaV1 } from "@kingsleyweb/bun-common";
import type { Job, JobsDriver } from "../lib/index";
import { join } from "node:path";
import {
  createTestLogger,
  describeContract,
  getContract,
  noopLogger,
} from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import { z } from "zod";
import { s } from "../lib/api/schema/builder";
import {
  BunJobs,
  BunQueue,
  BunQueueWorker,
  JobDataValidationError,
  JobsError,
  MemoryDriver,
  UnrecoverableJobError,
} from "../lib/index";
import { JOB_CHECKS } from "../lib/queue/jobSchema";
import { testNamespace, waitFor } from "./helpers";

/**
 * Job data and result schemas (bun-validate V5a, plan
 * `docs/plans/bun-validate/` §4.8.1–§4.8.4, flows excepted): the
 * declaration, every enqueue site, the policies, the check before the
 * handler on every target, and results.
 *
 * Every test runs on the memory driver; `job-schema-backends.test.ts` runs
 * the round trip on every backend.
 */

const closers: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close().catch(() => undefined);
  }
});

/** A context on `driver` (a fresh memory driver by default), closed afterwards. */
function makeJobs(
  options: {
    /** The driver; shared to put two contexts on one store. */
    driver?: JobsDriver;
    /** The namespace; shared with `driver` for the same reason. */
    namespace?: string;
    /** The logger; `noopLogger` by default. */
    logger?: ReturnType<typeof createTestLogger>["logger"];
  } = {},
): BunJobs {
  const jobs = new BunJobs({
    namespace: options.namespace ?? testNamespace("v5a"),
    driver: options.driver ?? new MemoryDriver(),
    logger: options.logger ?? noopLogger,
  });
  closers.push(() => jobs.close());
  return jobs;
}

/** Starts the registry worker with a short poll, so a test does not wait. */
async function start(jobs: BunJobs): Promise<void> {
  await jobs.start({ pollInterval: 5, maxBlock: 10 });
}

/** Waits for a job to reach `state`, and answers with it. */
async function settled(
  queue: BunQueue<any, any, any, any>,
  id: string,
  state: string,
): Promise<Job<any, any>> {
  let job: Job<any, any> | null = null;
  await waitFor(
    async () => {
      job = await queue.getJob(id);
      return job?.state === state;
    },
    {
      timeout: 8_000,
      message: () => `job ${id} is ${job?.state}, not ${state}`,
    },
  );
  return job!;
}

/** The warnings a test logger collected. */
const warnings = (events: LogEvent[]): LogEvent[] =>
  events.filter((event) => event.level === "warn");

/** An e-mail job's data schema: a coercion and a default, so output ≠ input. */
const Email = z.object({
  to: z.email(),
  retries: z.coerce.number().default(3),
});

/** A value no test data contains elsewhere, to prove it never reaches a message or a log. */
const SECRET = "hunter2-not-an-email";

/** A hand-rolled Standard Schema whose `validate` is always asynchronous. */
function asyncSchema<T>(
  check: (value: unknown) => value is T,
  delayMs = 5,
): StandardSchemaV1<T, T> {
  return {
    "~standard": {
      version: 1,
      vendor: "test-async",
      validate: async (value) => {
        await Bun.sleep(delayMs);
        return check(value)
          ? { value }
          : { issues: [{ message: "Expected the async shape", path: ["n"] }] };
      },
    },
  };
}

/** `{ n: number }`, for the async schema. */
const isN = (value: unknown): value is { n: number } =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { n?: unknown }).n === "number";

describe("define(): the declaration", () => {
  it("lifts schema and its policies out of the options, and carries a jobs contract", async () => {
    const jobs = makeJobs();
    jobs.define("sendEmail", async () => ({ id: "x" }), {
      attempts: 5,
      priority: 2,
      schema: { data: Email, result: z.object({ id: z.string() }) },
      dataValidation: { process: "warn" },
      resultValidation: "error",
    });
    jobs.define("plain", async () => null, { attempts: 2 });

    const [sendEmail, plain] = jobs.definitions();
    // The options are plain data again: what `GET /definitions` serves and
    // what every job inherits as its defaults.
    expect(sendEmail.options).toEqual({ attempts: 5, priority: 2 });
    expect(JSON.parse(JSON.stringify(sendEmail.options))).toEqual({
      attempts: 5,
      priority: 2,
    });
    expect(sendEmail.schema?.data).toBe(Email);
    expect(sendEmail.dataValidation).toEqual({ process: "warn" });
    expect(sendEmail.resultValidation).toBe("error");
    expect(Object.keys(sendEmail)).toEqual([
      "name",
      "handler",
      "options",
      "schema",
      "dataValidation",
      "resultValidation",
    ]);

    // The contract: data inbound, result outbound, on the "jobs" transport.
    const contract = getContract(sendEmail);
    expect(contract?.transport.name).toBe("jobs");
    expect(contract?.meta.name).toBe("sendEmail");
    const described = describeContract(contract!);
    expect(described.entries.map((e) => [e.side, e.part])).toEqual([
      ["inbound", "data"],
      ["outbound", "result"],
    ]);
    expect(described.entries[0].schema).toBe(Email);

    // A definition without a schema carries none, and its options are untouched.
    expect(getContract(plain)).toBeUndefined();
    expect(plain.schema).toBeUndefined();
    expect(plain.options).toEqual({ attempts: 2 });

    // And a job added by the name inherits the options, never the schema.
    const job = await jobs.now("sendEmail", { to: "a@example.com" });
    expect(job.opts.attempts).toBe(5);
    expect(JSON.stringify(job.opts)).not.toContain("schema");
    expect(JSON.stringify(job.opts)).not.toContain("dataValidation");
  });

  it("refuses a schema that is not a Standard Schema, and a policy that is not a word", () => {
    const jobs = makeJobs();
    expect(() =>
      jobs.define("bad", async () => null, {
        schema: { data: { parse: () => 1 } as never },
      }),
    ).toThrow(/schema\.data must be a Standard Schema/);
    expect(() =>
      jobs.define("bad", async () => null, {
        schema: { data: Email },
        dataValidation: { enqueue: "loud" as never },
      }),
    ).toThrow(/dataValidation\.enqueue must be "off", "warn" or "error"/);
    expect(
      () =>
        new BunQueue("q", {
          namespace: "x",
          driver: new MemoryDriver(),
          schema: { data: 42 as never },
        }),
    ).toThrow(/schema\.data must be a Standard Schema/);
  });
});

describe("enqueue checks", () => {
  it("rejects add, now and run().start() with JobDataValidationError, writing nothing", async () => {
    const jobs = makeJobs();
    jobs.define("sendEmail", async () => null, { schema: { data: Email } });
    const queue = jobs.queue("jobs");

    const attempts: Promise<unknown>[] = [
      queue.add("sendEmail", { to: SECRET }),
      jobs.now("sendEmail", { to: SECRET }),
      jobs.run("sendEmail", { to: SECRET }).start(),
      queue.now("sendEmail", { to: SECRET }),
    ];
    for (const attempt of attempts) {
      const error = await attempt.catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(JobDataValidationError);
      const refused = error as JobDataValidationError;
      expect(refused.code).toBe("JOB_DATA_VALIDATION");
      expect(refused.target).toBe("data");
      expect(refused.issues[0]).toMatchObject({ target: "data", path: "to" });
      expect(refused.context).toMatchObject({
        name: "sendEmail",
        queue: "jobs",
        target: "data",
        definition: "sendEmail",
      });
      // Never the value: not in the message, not in the context.
      expect(refused.message).not.toContain(SECRET);
      expect(JSON.stringify(refused.context)).not.toContain(SECRET);
    }

    const counts = await queue.count();
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(0);

    // Valid data is stored as the producer sent it: the input, not the output.
    const job = await jobs.now("sendEmail", {
      to: "a@example.com",
      retries: "2",
    } as never);
    expect((await queue.getJob(job.id))?.data).toEqual({
      to: "a@example.com",
      retries: "2",
    });
  });

  it("checks the data's JSON form, which is what is stored and read back", async () => {
    const jobs = makeJobs();
    jobs.define("at", async () => null, {
      schema: { data: z.object({ at: z.date() }) },
    });
    // A `Date` is stored as a string, which `z.date()` will refuse before the
    // handler: refused here instead, rather than dying in the worker.
    const error = await jobs
      .now("at", { at: new Date() })
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(JobDataValidationError);
  });

  it("addBulk checks every entry before the first write: all or nothing", async () => {
    const jobs = makeJobs();
    jobs.define("sendEmail", async () => null, { schema: { data: Email } });
    jobs.define("other", async () => null);
    const queue = jobs.queue<unknown>("jobs");

    const error = await queue
      .addBulk([
        { name: "sendEmail", data: { to: "a@example.com" } },
        { name: "other", data: { anything: true } },
        { name: "sendEmail", data: { to: SECRET } },
        { name: "sendEmail", data: { to: "b@example.com" } },
      ])
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(JobDataValidationError);
    expect((error as JobDataValidationError).context.index).toBe(2);
    expect((await queue.count()).waiting).toBe(0);

    // The same with a repeat in the batch, which adds one entry at a time.
    const repeating = await queue
      .addBulk([
        {
          name: "sendEmail",
          data: { to: "a@example.com" },
          opts: { repeat: { every: 60_000 } },
        },
        { name: "sendEmail", data: { to: SECRET } },
      ])
      .catch((thrown: unknown) => thrown);
    expect(repeating).toBeInstanceOf(JobDataValidationError);
    expect(await queue.listRepeatables()).toEqual([]);
    expect((await queue.count()).delayed).toBe(0);

    // Valid entries all land.
    const added = await queue.addBulk([
      { name: "sendEmail", data: { to: "a@example.com" } },
      { name: "other", data: { anything: true } },
    ]);
    expect(added.map((job) => job.wasAdded)).toEqual([true, true]);
  });

  it("addBulk with an async schema still rejects before any write", async () => {
    const queue = new BunQueue("bulk", {
      namespace: testNamespace("v5a"),
      driver: new MemoryDriver(),
      logger: noopLogger,
      schema: { data: asyncSchema(isN) },
    });
    closers.push(() => queue.close());
    const error = await queue
      .addBulk([
        { name: "n", data: { n: 1 } },
        { name: "n", data: { n: "two" } as never },
      ])
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(JobDataValidationError);
    expect((await queue.count()).waiting).toBe(0);
  });

  it("update, job.updateData and job.update check the new data, leaving the job unchanged", async () => {
    const jobs = makeJobs();
    jobs.define("sendEmail", async () => null, { schema: { data: Email } });
    const queue = jobs.queue<unknown>("jobs");
    const job = await jobs.now("sendEmail", { to: "a@example.com" });

    for (const attempt of [
      queue.update(job.id, { data: { to: SECRET } }),
      job.updateData({ to: SECRET }),
      job.update({ data: { to: SECRET }, priority: 4 }),
    ]) {
      const error = await attempt.catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(JobDataValidationError);
      expect((error as JobDataValidationError).context.jobId).toBe(job.id);
    }
    const stored = await queue.getJob(job.id);
    expect(stored?.data).toEqual({ to: "a@example.com" });
    expect(stored?.priority).toBe(job.priority);

    // Valid data passes every route.
    expect(
      (await queue.update(job.id, { data: { to: "b@example.com" } }))?.data,
    ).toEqual({ to: "b@example.com" });
    expect((await job.updateData({ to: "c@example.com" }))?.data).toEqual({
      to: "c@example.com",
    });
    // A patch without data is not checked.
    expect((await job.update({ priority: 7 }))?.priority).toBe(7);
    // A job that is gone is left to the write, which answers null.
    expect(await queue.update("missing", { data: { to: SECRET } })).toBeNull();
  });

  it("a debounce checks the new add before it replaces the pending job's data", async () => {
    const queue = new BunQueue("debounce", {
      namespace: testNamespace("v5a"),
      driver: new MemoryDriver(),
      logger: noopLogger,
      schema: { data: Email },
    });
    closers.push(() => queue.close());
    const debounce = { id: "doc-7", ttl: 60_000 };
    const first = await queue.add(
      "sendEmail",
      { to: "a@example.com" },
      { debounce, delay: 60_000 },
    );

    const error = await queue
      .add("sendEmail", { to: SECRET }, { debounce, delay: 60_000 })
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(JobDataValidationError);
    expect((await queue.getJob(first.id))?.data).toEqual({
      to: "a@example.com",
    });

    // A valid one still replaces it, as a debounce does.
    await queue.add(
      "sendEmail",
      { to: "b@example.com" },
      { debounce, delay: 60_000 },
    );
    expect((await queue.getJob(first.id))?.data).toEqual({
      to: "b@example.com",
    });
  });

  it("a repeat series is checked once, at creation, including when no occurrence is left", async () => {
    const queue = new BunQueue("repeat", {
      namespace: testNamespace("v5a"),
      driver: new MemoryDriver(),
      logger: noopLogger,
      schema: { data: Email },
    });
    closers.push(() => queue.close());

    const error = await queue
      .add("sendEmail", { to: SECRET }, { repeat: { every: 60_000 } })
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(JobDataValidationError);

    // The "no occurrences left" branch writes the series before it throws;
    // the check comes first, so nothing is written there either.
    const ended = await queue
      .add(
        "sendEmail",
        { to: SECRET },
        { repeat: { every: 60_000, endAt: Date.now() - 60_000 } },
      )
      .catch((thrown: unknown) => thrown);
    expect(ended).toBeInstanceOf(JobDataValidationError);
    expect(await queue.listRepeatables()).toEqual([]);

    // A valid series is created as before.
    await queue.add(
      "sendEmail",
      { to: "a@example.com" },
      { repeat: { every: 60_000 } },
    );
    expect(await queue.listRepeatables()).toHaveLength(1);
  });

  it("a registry definition's schema applies to the registry queue only; another queue has its own", async () => {
    const jobs = makeJobs();
    jobs.define("sendEmail", async () => null, { schema: { data: Email } });
    // `jobs.queue("mail")` is not the registry's: its own worker decides.
    const other = await jobs.queue("mail").add("sendEmail", { to: SECRET });
    expect(other.wasAdded).toBe(true);
  });
});

describe("the enqueue policy", () => {
  it('"warn" writes the job and logs one warning, without the value', async () => {
    const { logger, events } = createTestLogger();
    const jobs = makeJobs({ logger });
    jobs.define("sendEmail", async () => null, {
      schema: { data: Email },
      dataValidation: { enqueue: "warn" },
    });

    const job = await jobs.now("sendEmail", { to: SECRET });
    expect(job.wasAdded).toBe(true);
    expect(job.data).toEqual({ to: SECRET });

    const warned = warnings(events);
    expect(warned).toHaveLength(1);
    expect(warned[0].fields).toMatchObject({
      name: "sendEmail",
      queue: "jobs",
      definition: "sendEmail",
      issues: [{ target: "data", path: "to" }],
    });
    expect(JSON.stringify(warned[0])).not.toContain(SECRET);
  });

  it('"off" does not check at enqueue', async () => {
    const { logger, events } = createTestLogger();
    const queue = new BunQueue("off", {
      namespace: testNamespace("v5a"),
      driver: new MemoryDriver(),
      logger,
      schema: { data: Email },
      dataValidation: { enqueue: "off" },
    });
    closers.push(() => queue.close());
    expect((await queue.add("x", { to: SECRET })).wasAdded).toBe(true);
    expect(warnings(events)).toHaveLength(0);
  });

  it("a definition's policy wins over the queue's", async () => {
    const jobs = makeJobs();
    jobs.queue("jobs", { dataValidation: { enqueue: "off" } });
    jobs.define("strict", async () => null, { schema: { data: Email } });
    jobs.define("loose", async () => null, {
      schema: { data: Email },
      dataValidation: { enqueue: "off" },
    });
    // The definition sets nothing, so the queue's "off" applies.
    expect((await jobs.now("strict", { to: SECRET })).wasAdded).toBe(true);
    expect((await jobs.now("loose", { to: SECRET })).wasAdded).toBe(true);

    const strictQueue = makeJobs();
    strictQueue.define("strict", async () => null, {
      schema: { data: Email },
      dataValidation: { enqueue: "error" },
    });
    strictQueue.queue("jobs", { dataValidation: { enqueue: "off" } });
    await expect(
      strictQueue.now("strict", { to: SECRET }),
    ).rejects.toBeInstanceOf(JobDataValidationError);
  });
});

describe("the check before the handler", () => {
  it("hands an in-process handler the schema's output; the stored record keeps the input", async () => {
    const jobs = makeJobs();
    const seen: unknown[] = [];
    jobs.define(
      "sendEmail",
      async (job) => {
        seen.push(job.data);
        return null;
      },
      { schema: { data: Email } },
    );
    await start(jobs);
    const job = await jobs.now("sendEmail", {
      to: "a@example.com",
      retries: "4",
    } as never);
    const done = await settled(jobs.queue("jobs"), job.id, "completed");

    expect(seen).toEqual([{ to: "a@example.com", retries: 4 }]);
    expect(done.data).toEqual({ to: "a@example.com", retries: "4" });
  });

  it("deploy skew: data stored under no schema dies, unrecoverable, naming job, definition and issues, never the data", async () => {
    const driver = new MemoryDriver();
    const namespace = testNamespace("v5a");
    // The producer runs an older deployment, with no schema.
    const producer = makeJobs({ driver, namespace });
    producer.define("sendEmail", async () => null);
    // The worker runs the new one.
    const worker = makeJobs({ driver, namespace });
    let ran = 0;
    worker.define(
      "sendEmail",
      async () => {
        ran++;
      },
      { attempts: 5, schema: { data: Email } },
    );
    await start(worker);

    const job = await producer.now(
      "sendEmail",
      { to: SECRET },
      { attempts: 5 },
    );
    const dead = await settled(worker.queue("jobs"), job.id, "dead");

    expect(ran).toBe(0);
    expect(dead.attemptsMade).toBe(1);
    expect(dead.failedReason?.name).toBe("UnrecoverableJobError");
    expect(dead.failedReason?.message).toContain(job.id);
    expect(dead.failedReason?.message).toContain('"sendEmail"');
    expect(dead.failedReason?.message).toContain("data.to");
    expect(JSON.stringify(dead.toJSON().failedReason)).not.toContain(SECRET);
    expect(JSON.stringify(dead.toJSON().stacktrace)).not.toContain(SECRET);
  });

  it('"warn" at process runs the handler with the stored input, and logs one warning', async () => {
    const { logger, events } = createTestLogger();
    const jobs = makeJobs({ logger });
    const seen: unknown[] = [];
    jobs.define(
      "sendEmail",
      async (job) => {
        seen.push(job.data);
      },
      {
        schema: { data: Email },
        dataValidation: { enqueue: "off", process: "warn" },
      },
    );
    await start(jobs);
    const job = await jobs.now("sendEmail", { to: SECRET });
    await settled(jobs.queue("jobs"), job.id, "completed");

    expect(seen).toEqual([{ to: SECRET }]);
    const warned = warnings(events).filter((event) =>
      event.message.includes("processor gets the stored data"),
    );
    expect(warned).toHaveLength(1);
    expect(warned[0].fields).toMatchObject({
      jobId: job.id,
      name: "sendEmail",
    });
    expect(JSON.stringify(warned[0])).not.toContain(SECRET);
  });

  it('"off" at process does not check: the handler gets the stored input', async () => {
    const jobs = makeJobs();
    const seen: unknown[] = [];
    jobs.define(
      "sendEmail",
      async (job) => {
        seen.push(job.data);
      },
      {
        schema: { data: Email },
        dataValidation: { enqueue: "off", process: "off" },
      },
    );
    await start(jobs);
    const job = await jobs.now("sendEmail", {
      to: SECRET,
      retries: "2",
    } as never);
    await settled(jobs.queue("jobs"), job.id, "completed");
    expect(seen).toEqual([{ to: SECRET, retries: "2" }]);
  });

  it("a bare worker with no schema checks nothing; one with a schema checks", async () => {
    const driver = new MemoryDriver();
    const namespace = testNamespace("v5a");
    const queue = new BunQueue("bare", {
      namespace,
      driver,
      logger: noopLogger,
    });
    closers.push(() => queue.close());
    const job = await queue.add("x", { to: SECRET });

    const seen: unknown[] = [];
    const unchecked = new BunQueueWorker(
      "bare",
      async (j) => {
        seen.push(j.data);
      },
      {
        namespace,
        driver,
        logger: noopLogger,
        pollInterval: 5,
        waitToExit: false,
      },
    );
    closers.push(() => unchecked.close({ force: true }));
    void unchecked.run();
    await settled(queue, job.id, "completed");
    expect(seen).toEqual([{ to: SECRET }]);
    await unchecked.close();

    const second = await queue.add("x", { to: SECRET });
    const checked = new BunQueueWorker("bare", async () => null, {
      namespace,
      driver,
      logger: noopLogger,
      pollInterval: 5,
      waitToExit: false,
      schema: { data: Email },
    });
    closers.push(() => checked.close({ force: true }));
    void checked.run();
    const dead = await settled(queue, second.id, "dead");
    expect(dead.failedReason?.name).toBe("UnrecoverableJobError");
  });

  it("re-validates from the stored input on every attempt, retries included", async () => {
    let validations = 0;
    const counting: StandardSchemaV1<unknown, { n: number }> = {
      "~standard": {
        version: 1,
        vendor: "test-count",
        validate: (value) => {
          validations++;
          const n = (value as { n: unknown }).n;
          return { value: { n: Number(n) + 1 } };
        },
      },
    };
    const jobs = makeJobs();
    const seen: unknown[] = [];
    jobs.define(
      "flaky",
      async (job) => {
        seen.push(job.data);
        if (seen.length < 3) throw new Error("again");
      },
      { attempts: 3, backoff: 1, schema: { data: counting } },
    );
    await start(jobs);
    const job = await jobs.now("flaky", { n: 1 });
    const done = await settled(jobs.queue("jobs"), job.id, "completed");
    // The handler saw the output each time, computed from the same input.
    expect(seen).toEqual([{ n: 2 }, { n: 2 }, { n: 2 }]);
    // One check at enqueue, then one per attempt.
    expect(validations).toBe(4);
    expect(done.data).toEqual({ n: 1 });
  });

  it("async schemas: an async data schema is awaited before the handler", async () => {
    const jobs = makeJobs();
    const seen: unknown[] = [];
    jobs.define(
      "n",
      async (job) => {
        seen.push(job.data);
      },
      { schema: { data: asyncSchema(isN, 20) } },
    );
    await start(jobs);
    await expect(jobs.now("n", { n: "x" })).rejects.toBeInstanceOf(
      JobDataValidationError,
    );
    const job = await jobs.now("n", { n: 3 });
    await settled(jobs.queue("jobs"), job.id, "completed");
    expect(seen).toEqual([{ n: 3 }]);
  });

  it("zod's async refinements and bun-jobs' own `s` both work", async () => {
    const jobs = makeJobs();
    const Async = z.object({
      code: z.string().refine(async (value) => {
        await Bun.sleep(1);
        return value.startsWith("ok");
      }),
    });
    jobs.define("zodAsync", async (job) => job.data.code, {
      schema: { data: Async },
    });
    jobs.define("withS", async (job) => job.data.n * 2, {
      schema: { data: s.object({ n: s.integer() }), result: s.integer() },
      resultValidation: "error",
    });
    await start(jobs);
    const queue = jobs.queue("jobs");

    await expect(jobs.now("zodAsync", { code: "bad" })).rejects.toBeInstanceOf(
      JobDataValidationError,
    );
    await expect(jobs.now("withS", { n: "x" } as never)).rejects.toBeInstanceOf(
      JobDataValidationError,
    );

    const a = await jobs.now("zodAsync", { code: "ok-1" });
    const b = await jobs.now("withS", { n: 21 });
    expect((await settled(queue, a.id, "completed")).returnValue).toBe("ok-1");
    expect((await settled(queue, b.id, "completed")).returnValue).toBe(42);
  });
});

describe("isolated targets get the jsonClone of the output", () => {
  const handler = join(
    import.meta.dir,
    "fixtures",
    "handlers",
    "job-schema-report.ts",
  );

  for (const mode of [
    "worker-thread",
    "child-process",
    "in-process",
  ] as const) {
    it(`${mode}: a coercion arrives; a Date arrives as a string in an isolated one`, async () => {
      const driver = new MemoryDriver();
      const namespace = testNamespace("v5a");
      const queue = new BunQueue("iso", {
        namespace,
        driver,
        logger: noopLogger,
      });
      const worker = new BunQueueWorker("iso", handler, {
        namespace,
        driver,
        logger: noopLogger,
        pollInterval: 5,
        waitToExit: false,
        target:
          mode === "child-process"
            ? { kind: mode, closeTimeout: 200, killTimeout: 200 }
            : mode === "worker-thread"
              ? { kind: mode, closeTimeout: 200 }
              : mode,
        schema: {
          data: z.object({ n: z.coerce.number(), at: z.coerce.date() }),
        },
      });
      closers.push(
        () => queue.close(),
        () => worker.close({ force: true }),
      );
      void worker.run();

      const at = "2026-10-21T10:00:00.000Z";
      const job = await queue.add("report", { n: "7", at });
      const done = await settled(queue, job.id, "completed");
      expect(done.returnValue).toEqual({
        data: { n: 7, at },
        types: {
          n: "number",
          at: mode === "in-process" ? "date" : "string",
        },
      });
      // The stored record is the producer's input, whatever the target.
      expect(done.data).toEqual({ n: "7", at });
    }, 30_000);
  }

  it("an output that cannot be cloned fails the attempt as unrecoverable, never sending the input", async () => {
    const driver = new MemoryDriver();
    const namespace = testNamespace("v5a");
    const queue = new BunQueue("iso", {
      namespace,
      driver,
      logger: noopLogger,
    });
    const worker = new BunQueueWorker("iso", handler, {
      namespace,
      driver,
      logger: noopLogger,
      pollInterval: 5,
      waitToExit: false,
      target: { kind: "worker-thread", closeTimeout: 200 },
      schema: {
        data: z.object({ n: z.string().transform((value) => BigInt(value)) }),
      },
    });
    closers.push(
      () => queue.close(),
      () => worker.close({ force: true }),
    );
    void worker.run();

    const job = await queue.add("report", { n: "7" }, { attempts: 3 });
    const dead = await settled(queue, job.id, "dead");
    expect(dead.attemptsMade).toBe(1);
    expect(dead.failedReason?.name).toBe("UnrecoverableJobError");
    expect(dead.failedReason?.message).toContain("worker-thread target");
    expect(dead.failedReason?.message).toContain('"report"');
    expect(dead.returnValue).toBeNull();
  }, 30_000);
});

describe("results", () => {
  it('"error": a refused result fails the attempt, retryably; no completed event, nothing stored or published', async () => {
    const driver = new MemoryDriver();
    const namespace = testNamespace("v5a");
    const jobs = makeJobs({ driver, namespace });
    let calls = 0;
    jobs.define(
      "count",
      async () => {
        calls++;
        // Wrong the first time (a cast past the result's type); right the second.
        return calls === 1 ? ({ id: 1 } as never) : { id: "ok" };
      },
      {
        attempts: 2,
        backoff: 1,
        schema: { result: z.object({ id: z.string() }) },
        resultValidation: "error",
      },
    );
    const watcher = new BunQueue("jobs", {
      namespace,
      driver,
      logger: noopLogger,
      subscribe: true,
    });
    closers.push(() => watcher.close());
    await watcher.connect();
    const published: string[] = [];
    watcher.on("completed", (job) => published.push(`completed:${job.id}`));
    watcher.on("failed", (job) => published.push(`failed:${job.id}`));

    const worker = await jobs.start({
      pollInterval: 5,
      maxBlock: 10,
      publish: true,
    });
    const local: string[] = [];
    worker.on("completed", (_job, result) =>
      local.push(`completed:${JSON.stringify(result)}`),
    );
    worker.on("failed", (_job, error) => local.push(`failed:${error.name}`));

    const job = await jobs.now("count");
    const done = await settled(jobs.queue("jobs"), job.id, "completed");
    expect(calls).toBe(2);
    expect(done.attemptsMade).toBe(2);
    expect(done.returnValue).toEqual({ id: "ok" });
    expect(done.stacktrace[0]?.name).toBe("JobDataValidationError");
    expect(local).toEqual([
      "failed:JobDataValidationError",
      'completed:{"id":"ok"}',
    ]);
    await waitFor(() => published.length === 2);
    expect(published).toEqual([`failed:${job.id}`, `completed:${job.id}`]);
  });

  it('"error" with no attempts left: the job fails with no returnValue', async () => {
    const jobs = makeJobs();
    jobs.define("bad", async () => ({ id: 1 }) as never, {
      schema: { result: z.object({ id: z.string() }) },
      resultValidation: "error",
    });
    await start(jobs);
    const job = await jobs.now("bad");
    const dead = await settled(jobs.queue("jobs"), job.id, "dead");
    expect(dead.returnValue).toBeNull();
    expect(dead.failedReason?.name).toBe("JobDataValidationError");
    expect(dead.failedReason?.message).toContain("result.id");
  });

  it('"error": a child whose result is refused delivers nothing to its parent', async () => {
    const jobs = makeJobs();
    jobs.define("child", async () => ({ id: 1 }) as never, {
      schema: { result: z.object({ id: z.string() }) },
      resultValidation: "error",
    });
    jobs.define("parent", async (job) => await job.getChildrenValues());
    await start(jobs);
    const queue = jobs.queue("jobs");
    const flow = await queue.addFlow({
      name: "parent",
      data: undefined,
      children: [{ name: "child", data: undefined }],
    });
    const child = flow.children[0].job;
    await settled(queue, child.id, "dead");
    const parent = await queue.getJob(flow.job.id);
    expect(await parent?.getChildrenValues()).toEqual({});
  });

  it('"warn" completes as today and logs one warning; "off" (default) does not check', async () => {
    const { logger, events } = createTestLogger();
    const jobs = makeJobs({ logger });
    jobs.define("warned", async () => ({ id: SECRET.length }) as never, {
      schema: { result: z.object({ id: z.string() }) },
      resultValidation: "warn",
    });
    jobs.define("unchecked", async () => ({ id: 1 }) as never, {
      schema: { result: z.object({ id: z.string() }) },
    });
    await start(jobs);
    const queue = jobs.queue("jobs");
    const warnedJob = await jobs.now("warned");
    const unchecked = await jobs.now("unchecked");
    expect(
      (await settled(queue, warnedJob.id, "completed")).returnValue,
    ).toEqual({
      id: SECRET.length,
    });
    expect(
      (await settled(queue, unchecked.id, "completed")).returnValue,
    ).toEqual({
      id: 1,
    });
    const warned = warnings(events).filter((event) =>
      event.message.includes("Job result did not pass"),
    );
    expect(warned).toHaveLength(1);
    expect(warned[0].fields).toMatchObject({
      jobId: warnedJob.id,
      issues: [{ target: "result", path: "id" }],
    });
  });

  it("stores what the handler returned, not a transforming schema's output", async () => {
    const jobs = makeJobs();
    jobs.define("t", async () => "abc", {
      schema: { result: z.string().transform((value) => value.length) },
      resultValidation: "error",
    });
    await start(jobs);
    const job = await jobs.now("t");
    expect(
      (await settled(jobs.queue("jobs"), job.id, "completed")).returnValue,
    ).toBe("abc");
  });

  it("an async result schema delays completion until it settles", async () => {
    const jobs = makeJobs();
    let settledAt = 0;
    const slow: StandardSchemaV1<number, number> = {
      "~standard": {
        version: 1,
        vendor: "test-slow",
        validate: async (value) => {
          await Bun.sleep(150);
          settledAt = Date.now();
          return { value: value as number };
        },
      },
    };
    jobs.define("slow", async () => 1, {
      schema: { result: slow },
      resultValidation: "error",
    });
    const worker = await jobs.start({ pollInterval: 5, maxBlock: 10 });
    let completedAt = 0;
    worker.on("completed", () => {
      completedAt = Date.now();
    });
    const job = await jobs.now("slow");
    await settled(jobs.queue("jobs"), job.id, "completed");
    await waitFor(() => completedAt > 0);
    expect(settledAt).toBeGreaterThan(0);
    expect(completedAt).toBeGreaterThanOrEqual(settledAt);
  });
});

describe("no schema, no cost", () => {
  it("leaves the registry queue and its worker without a lookup until a definition has a schema", async () => {
    const jobs = makeJobs();
    jobs.define("plain", async () => null);
    const queue = jobs.queue("jobs");
    const worker = await jobs.start({ pollInterval: 5, maxBlock: 10 });
    expect(queue[JOB_CHECKS]).toBeUndefined();
    expect(worker[JOB_CHECKS]).toBeUndefined();
    // A bare queue and worker built without one carry none either.
    const bare = jobs.queue("other");
    expect(bare[JOB_CHECKS]).toBeUndefined();

    // Defining a schema later hands the lookup to both.
    jobs.define("checked", async () => null, { schema: { data: Email } });
    expect(queue[JOB_CHECKS]).toBeFunction();
    expect(worker[JOB_CHECKS]).toBeFunction();
    expect(bare[JOB_CHECKS]).toBeUndefined();
  });
});

describe("the error itself", () => {
  it("names the job, the queue and each issue, and never the value", () => {
    const error = new JobDataValidationError("sendEmail", "jobs", "data", [
      { target: "data", path: "to", message: "Invalid email address" },
      { target: "data", path: "", message: "Expected object" },
    ]);
    expect(error.message).toBe(
      'Job "sendEmail" data on queue "jobs" did not pass its schema: data.to: Invalid email address; data: Expected object',
    );
    expect(error.name).toBe("JobDataValidationError");
    expect(error).toBeInstanceOf(JobsError);
    // Not unrecoverable by itself: at enqueue it is the caller's, and a
    // refused result is retried like any thrown error.
    expect(error).not.toBeInstanceOf(UnrecoverableJobError);
  });
});
