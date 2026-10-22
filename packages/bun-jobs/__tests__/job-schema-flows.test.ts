import type { LogEvent, StandardSchemaV1 } from "@kingsleyweb/bun-common";
import type { FlowNode, Job, JobsDriver } from "../lib/index";
import { createTestLogger, noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import { z } from "zod";
import { s } from "../lib/api/schema/builder";
import {
  BunJobs,
  BunQueue,
  BunQueueWorker,
  ChildFailedError,
  JobDataValidationError,
  MemoryDriver,
  UnrecoverableJobError,
} from "../lib/index";
import { QUEUE_CHECKS } from "../lib/queue/jobSchema";
import { testNamespace, waitFor } from "./helpers";

/**
 * Job data schemas over flows (bun-validate V5c, plan
 * `docs/plans/bun-validate/` §4.8.2's `addFlow` row and §4.8.4): the
 * pre-write pass checks every node against its own name's schema on its own
 * queue before anything is written, under each node's enqueue policy; nodes
 * on other queues are checked where this process can see their checks; and
 * each node is processed and its result checked under its own name's
 * definition.
 *
 * Every test runs on the memory driver; `job-schema-backends.test.ts` runs
 * a flow on every backend, and `api/api-job-schema.test.ts` the flows route.
 */

const closers: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close().catch(() => undefined);
  }
});

/** A context on a fresh memory driver (or `driver`), closed afterwards. */
function makeJobs(
  options: {
    /** The driver; shared to put a bare queue on the same store. */
    driver?: JobsDriver;
    /** The namespace; shared with `driver` for the same reason. */
    namespace?: string;
    /** The logger; `noopLogger` by default. */
    logger?: ReturnType<typeof createTestLogger>["logger"];
  } = {},
): BunJobs {
  const jobs = new BunJobs({
    namespace: options.namespace ?? testNamespace("v5c"),
    driver: options.driver ?? new MemoryDriver(),
    logger: options.logger ?? noopLogger,
  });
  closers.push(() => jobs.close());
  return jobs;
}

/** A bare queue, closed afterwards. */
function bareQueue(
  name: string,
  options: ConstructorParameters<typeof BunQueue>[1],
): BunQueue<any, any> {
  const queue = new BunQueue(name, { logger: noopLogger, ...options });
  closers.push(() => queue.close());
  return queue;
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

/** Every job a queue holds, in any state. */
async function total(queue: BunQueue<any, any, any, any>): Promise<number> {
  const counts = await queue.count();
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

/** The warnings a test logger collected. */
const warnings = (events: LogEvent[]): LogEvent[] =>
  events.filter((event) => event.level === "warn");

/** An e-mail job's data schema: a coercion and a default, so output ≠ input. */
const Email = z.object({
  to: z.email(),
  retries: z.coerce.number().default(3),
});

/** A page job's data schema. */
const Page = z.object({ page: z.coerce.number().int() });

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

/** A driver whose every write fails, after any check has passed. */
class FailingWriteDriver extends MemoryDriver {
  override async addJob(): Promise<never> {
    throw new Error("the write failed");
  }
}

/** Rejects with whatever `run` rejects with, or fails the test when it resolves. */
async function refusal(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

describe("the pre-write pass", () => {
  it("a bad grandchild writes nothing for the whole flow", async () => {
    const jobs = makeJobs();
    jobs.define("report", async () => null, {
      schema: { data: z.object({ month: z.string() }) },
    });
    jobs.define("fetch", async () => null, { schema: { data: Page } });
    jobs.define("sendEmail", async () => null, { schema: { data: Email } });
    const queue = jobs.queue("jobs");

    const grandchild: FlowNode = {
      name: "sendEmail",
      data: { to: SECRET },
      opts: { jobId: "e1" },
    };
    const flow = {
      name: "report",
      data: { month: "2026-10" },
      opts: { jobId: "r1" },
      children: [
        {
          name: "fetch",
          data: { page: "1" },
          opts: { jobId: "f1" },
          children: [
            { name: "fetch", data: { page: 2 }, opts: { jobId: "f2" } },
            grandchild,
          ],
        },
        { name: "fetch", data: { page: 3 }, opts: { jobId: "f3" } },
      ],
    };
    const error = await refusal(() => queue.addFlow(flow));

    expect(error).toBeInstanceOf(JobDataValidationError);
    const refused = error as JobDataValidationError;
    expect(refused.context).toMatchObject({
      name: "sendEmail",
      queue: "jobs",
      target: "data",
      definition: "sendEmail",
      flowPath: "children.0.children.1",
      jobId: "e1",
    });
    expect(refused.issues.map((issue) => issue.path)).toEqual(["to"]);
    expect(refused.message).not.toContain(SECRET);
    expect(JSON.stringify(refused.context)).not.toContain(SECRET);

    // Nothing written: not one node, read through the driver by id.
    for (const id of ["r1", "f1", "f2", "e1", "f3"]) {
      expect(await queue.getJob(id)).toBeNull();
    }
    expect(await total(queue)).toBe(0);

    // The same flow with the grandchild fixed is written whole, each node
    // storing what the producer sent (the input, not the output).
    grandchild.data = { to: "a@example.com" };
    const added = await queue.addFlow(flow);
    expect(added.job.id).toBe("r1");
    expect(await total(queue)).toBe(5);
    expect((await queue.getJob("f1"))?.data).toEqual({ page: "1" });
  });

  it("names the top node with an empty flowPath, and the first failing node in tree order", async () => {
    const jobs = makeJobs();
    jobs.define("fetch", async () => null, { schema: { data: Page } });
    const queue = jobs.queue("jobs");

    const top = (await refusal(() =>
      queue.addFlow({
        name: "fetch",
        data: { page: "x" },
        children: [{ name: "fetch", data: { page: "y" } }],
      }),
    )) as JobDataValidationError;
    expect(top.context.flowPath).toBe("");
    expect(top.context).not.toHaveProperty("jobId");

    const second = (await refusal(() =>
      queue.addFlow({
        name: "fetch",
        data: { page: 1 },
        children: [
          { name: "fetch", data: { page: 2 } },
          { name: "fetch", data: { page: "z" } },
          { name: "fetch", data: { page: "w" } },
        ],
      }),
    )) as JobDataValidationError;
    expect(second.context.flowPath).toBe("children.1");
    expect(await total(queue)).toBe(0);
  });

  it("checks a node as add would: its JSON form, null for no data", async () => {
    const jobs = makeJobs();
    jobs.define("ping", async () => null, { schema: { data: z.null() } });
    jobs.define("at", async () => null, {
      schema: { data: z.object({ at: z.string() }) },
    });
    const queue = jobs.queue("jobs");
    // No data is stored as null, and checked as null.
    await queue.addFlow({
      name: "ping",
      data: undefined,
      children: [{ name: "at", data: { at: new Date(0) } }],
    });
    expect(await total(queue)).toBe(2);
  });

  it("awaits asynchronous schemas before the first write", async () => {
    const jobs = makeJobs();
    jobs.define("slow", async () => null, {
      schema: { data: asyncSchema(isN, 20) },
    });
    jobs.define("fetch", async () => null, { schema: { data: Page } });
    const queue = jobs.queue("jobs");

    const error = (await refusal(() =>
      queue.addFlow({
        name: "fetch",
        data: { page: 1 },
        children: [
          { name: "slow", data: { n: 1 } },
          { name: "slow", data: { n: "not a number" } },
        ],
      }),
    )) as JobDataValidationError;
    expect(error).toBeInstanceOf(JobDataValidationError);
    expect(error.context.flowPath).toBe("children.1");
    expect(await total(queue)).toBe(0);

    await queue.addFlow({
      name: "fetch",
      data: { page: 1 },
      children: [{ name: "slow", data: { n: 1 } }],
    });
    expect(await total(queue)).toBe(2);
  });

  it("works with bun-jobs' own `s`", async () => {
    const jobs = makeJobs();
    jobs.define("count", async () => null, {
      schema: { data: s.object({ n: s.integer() }) },
    });
    const queue = jobs.queue("jobs");
    const error = await refusal(() =>
      queue.addFlow({
        name: "count",
        data: { n: 1 },
        children: [{ name: "count", data: { n: 1.5 } }],
      }),
    );
    expect(error).toBeInstanceOf(JobDataValidationError);
    expect(await total(queue)).toBe(0);
  });

  it("a top job that already exists is still checked first, as add checks before its dedupe", async () => {
    const jobs = makeJobs();
    jobs.define("fetch", async () => null, { schema: { data: Page } });
    const queue = jobs.queue("jobs");
    await queue.addFlow({
      name: "fetch",
      data: { page: 1 },
      opts: { jobId: "x" },
    });
    const error = await refusal(() =>
      queue.addFlow({
        name: "fetch",
        data: { page: "bad" },
        opts: { jobId: "x" },
      }),
    );
    expect(error).toBeInstanceOf(JobDataValidationError);
    expect((await queue.getJob("x"))?.data).toEqual({ page: 1 });
  });
});

describe("children on other queues", () => {
  it("in a context: each node against its own queue's checks, the registry's definitions included", async () => {
    const jobs = makeJobs();
    jobs.define("report", async () => null, {
      schema: { data: z.object({ month: z.string() }) },
    });
    jobs.define("fetch", async () => null, { schema: { data: Page } });
    const registry = jobs.queue("jobs");
    const mail = jobs.queue("mail", { schema: { data: Email } });

    // A bad child on the mail queue, under its own `schema`.
    const onMail = (await refusal(() =>
      registry.addFlow({
        name: "report",
        data: { month: "2026-10" },
        children: [
          { name: "fetch", data: { page: 1 } },
          { name: "anything", data: { to: SECRET }, queue: "mail" },
        ],
      }),
    )) as JobDataValidationError;
    expect(onMail).toBeInstanceOf(JobDataValidationError);
    expect(onMail.context).toMatchObject({
      name: "anything",
      queue: "mail",
      flowPath: "children.1",
    });
    // The mail queue's own check names no definition.
    expect(onMail.context).not.toHaveProperty("definition");
    expect(await total(registry)).toBe(0);
    expect(await total(mail)).toBe(0);

    // A flow added on the mail queue checks its registry children against
    // their definitions, and a grandchild inheriting the registry queue too.
    const onRegistry = (await refusal(() =>
      mail.addFlow({
        name: "notify",
        data: { to: "a@example.com" },
        children: [
          {
            name: "report",
            data: { month: "2026-10" },
            queue: "jobs",
            children: [{ name: "fetch", data: { page: "nope" } }],
          },
        ],
      }),
    )) as JobDataValidationError;
    expect(onRegistry.context).toMatchObject({
      name: "fetch",
      queue: "jobs",
      definition: "fetch",
      flowPath: "children.0.children.0",
    });
    expect(await total(registry)).toBe(0);
    expect(await total(mail)).toBe(0);

    // A queue this context never created checks nothing at enqueue: its
    // worker, wherever it runs, checks before the handler.
    await registry.addFlow({
      name: "report",
      data: { month: "2026-10" },
      children: [{ name: "x", data: { anything: true }, queue: "elsewhere" }],
    });
    expect(await total(registry)).toBe(1);
  });

  it("the registry's definitions apply before the registry queue is created here", async () => {
    const jobs = makeJobs();
    jobs.define("fetch", async () => null, { schema: { data: Page } });
    const other = jobs.queue("other");
    const error = (await refusal(() =>
      other.addFlow({
        name: "top",
        data: null,
        children: [{ name: "fetch", data: { page: "x" }, queue: "jobs" }],
      }),
    )) as JobDataValidationError;
    expect(error.context).toMatchObject({
      queue: "jobs",
      flowPath: "children.0",
    });
    expect(await total(other)).toBe(0);
  });

  it("a bare queue checks its own nodes only: it cannot see another queue's checks", async () => {
    const driver = new MemoryDriver();
    const namespace = testNamespace("v5c");
    const top = bareQueue("top", { namespace, driver, schema: { data: Page } });
    const media = bareQueue("media", {
      namespace,
      driver,
      schema: { data: Email },
    });

    // Its own node: checked.
    const own = (await refusal(() =>
      top.addFlow({
        name: "p",
        data: { page: 1 },
        children: [{ name: "p", data: { page: "x" } }],
      }),
    )) as JobDataValidationError;
    expect(own.context).toMatchObject({ queue: "top", flowPath: "children.0" });
    expect(await total(top)).toBe(0);

    // A child on another queue: not checked here, though that queue has a
    // schema; its worker checks before the handler.
    await top.addFlow({
      name: "p",
      data: { page: 1 },
      children: [{ name: "m", data: { to: SECRET }, queue: "media" }],
    });
    expect(await total(top)).toBe(1);
    expect(await total(media)).toBe(1);
  });
});

describe("the enqueue policy, per node", () => {
  it('"warn" writes the flow and logs one warning for the node, without the value', async () => {
    const { logger, events } = createTestLogger();
    const jobs = makeJobs({ logger });
    jobs.define("fetch", async () => null, { schema: { data: Page } });
    jobs.define("sendEmail", async () => null, {
      schema: { data: Email },
      dataValidation: { enqueue: "warn" },
    });
    const queue = jobs.queue("jobs");

    await queue.addFlow({
      name: "fetch",
      data: { page: 1 },
      children: [
        { name: "fetch", data: { page: 2 } },
        { name: "sendEmail", data: { to: SECRET }, opts: { jobId: "e1" } },
      ],
    });

    expect(await total(queue)).toBe(3);
    const warned = warnings(events);
    expect(warned).toHaveLength(1);
    expect(warned[0].fields).toMatchObject({
      name: "sendEmail",
      queue: "jobs",
      flowPath: "children.1",
      jobId: "e1",
      definition: "sendEmail",
    });
    expect(JSON.stringify(warned)).not.toContain(SECRET);
  });

  it('"off" does not check the node, and a strict sibling still rejects the flow', async () => {
    const { logger, events } = createTestLogger();
    const jobs = makeJobs({ logger });
    jobs.define("fetch", async () => null, { schema: { data: Page } });
    jobs.define("sendEmail", async () => null, {
      schema: { data: Email },
      dataValidation: { enqueue: "off" },
    });
    const queue = jobs.queue("jobs");

    await queue.addFlow({
      name: "fetch",
      data: { page: 1 },
      children: [{ name: "sendEmail", data: { to: SECRET } }],
    });
    expect(await total(queue)).toBe(2);
    expect(warnings(events)).toHaveLength(0);

    const error = await refusal(() =>
      queue.addFlow({
        name: "fetch",
        data: { page: 1 },
        children: [
          { name: "sendEmail", data: { to: SECRET } },
          { name: "fetch", data: { page: "x" } },
        ],
      }),
    );
    expect(error).toBeInstanceOf(JobDataValidationError);
    expect(await total(queue)).toBe(2);
  });

  it("a queue's own policy applies to its nodes; a definition's wins on the registry", async () => {
    const { logger, events } = createTestLogger();
    const jobs = makeJobs({ logger });
    jobs.queue("mail", {
      schema: { data: Email },
      dataValidation: { enqueue: "warn" },
    });
    jobs.define("fetch", async () => null, { schema: { data: Page } });
    const registry = jobs.queue("jobs");
    await registry.addFlow({
      name: "fetch",
      data: { page: 1 },
      children: [{ name: "m", data: { to: SECRET }, queue: "mail" }],
    });
    expect(warnings(events)).toHaveLength(1);
    expect(warnings(events)[0].fields).toMatchObject({
      queue: "mail",
      flowPath: "children.0",
    });
  });
});

describe("the enqueue policy beneath a definition", () => {
  it("a node on another queue takes that queue's own policy when its definition sets none", async () => {
    const { logger, events } = createTestLogger();
    const jobs = makeJobs({ logger });
    // The registry queue's own policy, with no schema of its own.
    const registry = jobs.queue("jobs", {
      dataValidation: { enqueue: "warn" },
    });
    jobs.define("fetch", async () => null, { schema: { data: Page } });
    const other = jobs.queue("other");

    await other.addFlow({
      name: "top",
      data: null,
      children: [{ name: "fetch", data: { page: "x" }, queue: "jobs" }],
    });
    expect(await total(registry)).toBe(1);
    expect(warnings(events)).toHaveLength(1);
    expect(warnings(events)[0].fields).toMatchObject({
      name: "fetch",
      queue: "jobs",
      flowPath: "children.0",
    });
  });
});

describe("no schema, no cost", () => {
  it("a context's queues carry no cross-queue lookup until a schema exists in it", async () => {
    const jobs = makeJobs();
    jobs.define("plain", async () => null);
    const registry = jobs.queue("jobs");
    const other = jobs.queue("other");
    expect(registry[QUEUE_CHECKS]).toBeUndefined();
    expect(other[QUEUE_CHECKS]).toBeUndefined();
    // A flow there walks nothing and writes as before.
    await registry.addFlow({
      name: "plain",
      data: null,
      children: [{ name: "x", data: null, queue: "other" }],
    });

    // A queue created with its own schema hands the lookup to every queue.
    jobs.queue("mail", { schema: { data: Email } });
    expect(registry[QUEUE_CHECKS]).toBeFunction();
    expect(other[QUEUE_CHECKS]).toBeFunction();
    expect(jobs.queue("later")[QUEUE_CHECKS]).toBeFunction();
  });

  it("a definition with a schema hands the lookup to every queue of the context", async () => {
    const jobs = makeJobs();
    const other = jobs.queue("other");
    expect(other[QUEUE_CHECKS]).toBeUndefined();
    jobs.define("fetch", async () => null, { schema: { data: Page } });
    expect(other[QUEUE_CHECKS]).toBeFunction();
  });

  it("a bare queue never carries one", () => {
    const queue = bareQueue("solo", {
      namespace: testNamespace("v5c"),
      driver: new MemoryDriver(),
      schema: { data: Page },
    });
    expect(queue[QUEUE_CHECKS]).toBeUndefined();
  });
});

describe("processing, per node", () => {
  it("each node's handler gets its own name's output, and the parent reads its children's results", async () => {
    const jobs = makeJobs();
    const seen: Record<string, unknown[]> = { fetch: [], sendEmail: [] };
    jobs.define(
      "fetch",
      async (job) => {
        seen.fetch.push(job.data);
        return { rows: 2 };
      },
      {
        schema: { data: Page, result: z.object({ rows: z.number() }) },
        resultValidation: "error",
      },
    );
    jobs.define(
      "sendEmail",
      async (job) => {
        seen.sendEmail.push(job.data);
        return { id: "m1" };
      },
      {
        schema: { data: Email, result: z.object({ id: z.string() }) },
        resultValidation: "error",
      },
    );
    jobs.define("report", async (job) => await job.getChildrenValues());
    await jobs.start({ pollInterval: 5, maxBlock: 10 });
    const queue = jobs.queue("jobs");

    const flow = await queue.addFlow({
      name: "report",
      data: null,
      children: [
        { name: "fetch", data: { page: "4" }, opts: { jobId: "f" } },
        {
          name: "sendEmail",
          data: { to: "a@example.com" },
          opts: { jobId: "e" },
        },
      ],
    });
    const parent = await settled(queue, flow.job.id, "completed");

    expect(seen.fetch).toEqual([{ page: 4 }]);
    expect(seen.sendEmail).toEqual([{ to: "a@example.com", retries: 3 }]);
    expect(parent.returnValue).toEqual({
      "jobs:f": { rows: 2 },
      "jobs:e": { id: "m1" },
    });
  });

  it("a node whose stored data fails its own definition dies unrecoverable, and fails its parent", async () => {
    const jobs = makeJobs();
    let ran = 0;
    jobs.define(
      "sendEmail",
      async () => {
        ran++;
      },
      {
        attempts: 3,
        schema: { data: Email },
        // Written unchecked, so only the worker's own check stands.
        dataValidation: { enqueue: "off" },
      },
    );
    jobs.define("report", async () => null);
    await jobs.start({ pollInterval: 5, maxBlock: 10 });
    const queue = jobs.queue("jobs");

    const flow = await queue.addFlow({
      name: "report",
      data: null,
      children: [
        { name: "sendEmail", data: { to: SECRET }, opts: { jobId: "e" } },
      ],
    });
    const child = await settled(queue, "e", "dead");
    expect(ran).toBe(0);
    expect(child.attemptsMade).toBe(1);
    expect(child.failedReason?.name).toBe(UnrecoverableJobError.name);
    const parent = await settled(queue, flow.job.id, "dead");
    expect(parent.failedReason?.name).toBe(ChildFailedError.name);
    expect(JSON.stringify(parent.toJSON())).not.toContain(SECRET);
  });

  it("a cross-queue child is processed under its own worker's schema", async () => {
    const driver = new MemoryDriver();
    const namespace = testNamespace("v5c");
    const top = bareQueue("top", { namespace, driver });
    const seen: unknown[] = [];
    const worker = new BunQueueWorker(
      "media",
      async (job) => {
        seen.push(job.data);
        return null;
      },
      {
        namespace,
        driver,
        logger: noopLogger,
        pollInterval: 5,
        waitToExit: false,
        schema: { data: Page },
      },
    );
    closers.push(() => worker.close({ force: true }));
    void worker.run();

    const flow = await top.addFlow({
      name: "parent",
      data: null,
      children: [
        {
          name: "good",
          data: { page: "2" },
          queue: "media",
          opts: { jobId: "g" },
        },
        {
          name: "bad",
          data: { page: "x" },
          queue: "media",
          opts: { jobId: "b", ignoreFailure: true },
        },
      ] satisfies FlowNode[],
    });
    const media = bareQueue("media", { namespace, driver });
    await settled(media, "g", "completed");
    const bad = await settled(media, "b", "dead");
    expect(bad.failedReason?.name).toBe(UnrecoverableJobError.name);
    expect(seen).toEqual([{ page: 2 }]);
    // The parent waits on both, the failure ignored.
    await waitFor(async () => {
      const job = await top.getJob(flow.job.id);
      return job?.state === "waiting";
    });
  });
});

describe('a "warn" node in a write another entry refuses', () => {
  /** Refuses every `page` after an await, as an async vendor check would. */
  const SlowPage = z.object({ page: z.number() }).refine(async () => false);

  /** A context where `sendEmail` warns and `fetch`/`slow` refuse. */
  function warnBeside(logger: ReturnType<typeof createTestLogger>["logger"]) {
    const jobs = makeJobs({ logger });
    jobs.define("fetch", async () => null, { schema: { data: Page } });
    jobs.define("slow", async () => null, { schema: { data: SlowPage } });
    jobs.define("sendEmail", async () => null, {
      schema: { data: Email },
      dataValidation: { enqueue: "warn" },
    });
    return jobs.queue("jobs");
  }

  it("a flow refused by a later node logs no warning, as nothing is written", async () => {
    const { logger, events } = createTestLogger();
    const queue = warnBeside(logger);
    const error = await refusal(() =>
      queue.addFlow({
        name: "fetch",
        data: { page: 1 },
        children: [
          { name: "sendEmail", data: { to: SECRET } },
          { name: "fetch", data: { page: "x" } },
        ],
      }),
    );
    expect((error as JobDataValidationError).context).toMatchObject({
      flowPath: "children.1",
    });
    expect(await total(queue)).toBe(0);
    expect(warnings(events)).toHaveLength(0);
  });

  it("the same when the refusal comes from an asynchronous check", async () => {
    const { logger, events } = createTestLogger();
    const queue = warnBeside(logger);
    const error = await refusal(() =>
      queue.addFlow({
        name: "fetch",
        data: { page: 1 },
        children: [
          { name: "sendEmail", data: { to: SECRET } },
          { name: "slow", data: { page: 2 } },
        ],
      }),
    );
    expect((error as JobDataValidationError).context).toMatchObject({
      flowPath: "children.1",
    });
    expect(await total(queue)).toBe(0);
    expect(warnings(events)).toHaveLength(0);
  });

  it("a bulk refused by a later entry logs no warning either", async () => {
    const { logger, events } = createTestLogger();
    const queue = warnBeside(logger);
    const error = await refusal(() =>
      queue.addBulk([
        { name: "sendEmail", data: { to: SECRET } },
        { name: "fetch", data: { page: "x" } },
      ]),
    );
    expect((error as JobDataValidationError).context).toMatchObject({
      index: 1,
    });
    expect(await total(queue)).toBe(0);
    expect(warnings(events)).toHaveLength(0);
  });

  it("once every other entry passes, the warning is logged, after an asynchronous check too", async () => {
    const { logger, events } = createTestLogger();
    const jobs = makeJobs({ logger });
    jobs.define("fetch", async () => null, { schema: { data: Page } });
    jobs.define("later", async () => null, {
      schema: {
        data: z.object({ page: z.number() }).refine(async () => true),
      },
    });
    jobs.define("sendEmail", async () => null, {
      schema: { data: Email },
      dataValidation: { enqueue: "warn" },
    });
    const queue = jobs.queue("jobs");
    await queue.addFlow({
      name: "fetch",
      data: { page: 1 },
      children: [
        { name: "sendEmail", data: { to: SECRET } },
        { name: "later", data: { page: 2 } },
      ],
    });
    expect(await total(queue)).toBe(3);
    expect(warnings(events)).toHaveLength(1);
    await queue.addBulk([
      { name: "sendEmail", data: { to: SECRET } },
      { name: "later", data: { page: 3 } },
    ]);
    expect(warnings(events)).toHaveLength(2);
  });

  it('a "warn" node logs nothing when the flow\'s write fails after every check passed', async () => {
    const { logger, events } = createTestLogger();
    const queue = bareQueue("jobs", {
      namespace: testNamespace("v5c"),
      driver: new FailingWriteDriver(),
      logger,
      schema: { data: Email },
      dataValidation: { enqueue: "warn" },
    });

    // Every node's check passed, but the write failed: nothing was written
    // anyway, so there is nothing to warn about.
    await expect(
      queue.addFlow({
        name: "sendEmail",
        data: { to: SECRET },
        children: [{ name: "sendEmail", data: { to: SECRET } }],
      }),
    ).rejects.toThrow("the write failed");
    expect(warnings(events)).toHaveLength(0);
  });
});
