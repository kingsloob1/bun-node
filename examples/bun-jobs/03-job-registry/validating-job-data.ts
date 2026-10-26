/**
 * Validating job data and results — a schema on `define()`, checked where a
 * job is added and again before its handler runs.
 *
 * ```bash
 * bun 03-job-registry/validating-job-data.ts
 * EXAMPLE_DRIVER=sqlite bun 03-job-registry/validating-job-data.ts
 * ```
 *
 * `schema: { data, result }` takes any [Standard Schema](https://standardschema.dev):
 * zod here, and valibot, arktype, yup or bun-jobs' own `s` the same way. It
 * goes on `jobs.define()`, and on `jobs.queue()`, `jobs.worker()`,
 * `jobs.start()`, `new BunQueue` and `new BunQueueWorker` for a queue of
 * their own. Two policies say what a failure does, each `"error"`, `"warn"`
 * or `"off"`: `dataValidation: { enqueue, process }` (both `"error"` by
 * default) and `resultValidation` (`"off"` by default).
 *
 * Worth knowing:
 *
 * - **Data is checked twice.** At enqueue, before anything is written —
 *   `now`, a builder's `start()`, a draft's `save()`, a repeat series, a
 *   debounce, `addBulk` (all or nothing), an update — rejecting with
 *   `JobDataValidationError` (`JOB_DATA_VALIDATION`). Then again in the
 *   worker before the handler, because the job may have been added by a
 *   deployment that had another schema, or none.
 * - **Store the input, hand the handler the output.** The stored data is what
 *   the producer sent; the handler gets the schema's output (`z.coerce.date()`
 *   gives it a `Date`). A `Worker`, child process or container gets that output
 *   through JSON, so there a `Date` arrives as its ISO string.
 * - **A job with no data is checked as `null`.** Give a name that takes none a
 *   schema that accepts `null` (`.nullable()`, `.nullish()`).
 * - **Deploy skew is not retried.** Stored data that fails the worker's schema
 *   sends the job straight to `dead` with an `UnrecoverableJobError`: no retry
 *   would change the data.
 * - **Never the value.** An error or a warning names the job, its definition,
 *   the paths and the messages, never the data that failed — not even over
 *   HTTP, where the management API answers 400 `VALIDATION` with the issues at
 *   `data.<path>`.
 */
// The request and response types of the wire contract, browser-safe.
import type {
  DefinitionListDto,
  ProblemDto,
} from "@kingsleyweb/bun-jobs/api/contract";
import type { Arrival } from "./processors/report-arrival";
import { BunHttpAdapter, createTestLogger } from "@kingsleyweb/bun-common";
import {
  BunJobs,
  createDriver,
  createJobsApi,
  JobDataValidationError,
  JOBS_API_ACTIONS,
  JOBS_API_OPT_IN_ACTIONS,
} from "@kingsleyweb/bun-jobs";
import { z } from "zod";
import { exampleDriver, exampleNamespace } from "../shared/backend";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";

title("Job registry: validating job data and results");

/**
 * A value that must never reach an error, a warning, a stored failure or a
 * response: every bad payload below carries it.
 */
const SECRET = "hunter2-not-an-email";

/** One driver for every context here, so an "older deployment" shares its store. */
const driver = createDriver(exampleDriver());
const namespace = exampleNamespace("validating");

// The workers log the failures they record; collected, so the checks can read
// the warnings, instead of printed.
const { logger, events } = createTestLogger();

const jobs = new BunJobs({ namespace, driver, logger });
const registry = jobs.queue("jobs");

/** Every job, in every state, on the registry queue. */
async function stored(): Promise<number> {
  const counts = await registry.count();
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

/** The warnings logged so far whose message contains `text`. */
function warnings(text: string) {
  return events.filter(
    (event) => event.level === "warn" && event.message.includes(text),
  );
}

/** A queue, as far as reading a job back by id goes. */
interface JobReader<TJob> {
  /** The job with this id, or `null`. */
  getJob: (id: string) => Promise<TJob | null>;
}

/** Waits for a job to reach `state` on `queue`, and answers with it as stored. */
async function settle<TJob extends { state: string }>(
  queue: JobReader<TJob>,
  id: string,
  state: string,
): Promise<TJob> {
  let job: TJob | null = null;
  await waitFor(`job ${id} to be ${state}`, async () => {
    job = await queue.getJob(id);
    return job?.state === state;
  });
  return job!;
}

/* ------------------------------------------------------------------ */
step("define(): a zod schema for what a job carries");

/** A welcome e-mail: a coercion and a default, so the output is not the input. */
const Welcome = z.object({
  email: z.email(),
  signedUpAt: z.coerce.date(),
  plan: z.enum(["free", "pro"]).default("free"),
});

/** What each welcome handler call was handed, by job id. */
const handed = new Map<string, z.output<typeof Welcome>>();

jobs.define(
  "sendWelcome",
  // `job.data` is the schema's output: `signedUpAt` is a `Date`, `plan` is set.
  (job) => {
    handed.set(job.id, job.data);
  },
  { attempts: 5, schema: { data: Welcome } },
);

/** Data that fails `Welcome` twice over: not an e-mail, not a date. */
const bad = { email: SECRET, signedUpAt: "last tuesday" };
/** Data that passes it, as a producer would send it: a date as a string. */
const good = {
  email: "ada@example.com",
  signedUpAt: "2026-10-21T09:00:00.000Z",
};

const definition = jobs.definitions().find((d) => d.name === "sendWelcome");
check(
  "define() lifts the schema out of the options",
  definition?.schema?.data === Welcome && !("schema" in definition.options),
  definition,
);
checkEqual("the options stay plain data", definition?.options, { attempts: 5 });

/* ------------------------------------------------------------------ */
step("Every way of adding it checks the data first, and writes nothing");

const refused = await checkRejects(
  "jobs.now() with bad data",
  () => jobs.now("sendWelcome", bad),
  { name: "JobDataValidationError", code: "JOB_DATA_VALIDATION" },
);
show("the error", refused?.message);
if (refused instanceof JobDataValidationError) {
  checkEqual(
    "it names the job, its definition and what failed",
    [refused.target, refused.context.name, refused.context.definition],
    ["data", "sendWelcome", "sendWelcome"],
  );
  checkEqual(
    "the issues: one per field, by path",
    refused.issues.map((issue) => issue.path),
    ["email", "signedUpAt"],
  );
} else {
  check("the error is a JobDataValidationError", false, refused);
}
check(
  "and never the value",
  !JSON.stringify({ message: refused?.message, error: refused }).includes(
    SECRET,
  ),
  refused?.message,
);

/** The other ways to add a job, each given the same bad data. */
const sites: [string, () => Promise<unknown>][] = [
  ["the registry queue's add()", () => registry.add("sendWelcome", bad)],
  [
    "a builder's start()",
    () => jobs.run("sendWelcome").withData(bad).in("1 hour").start(),
  ],
  ["a draft's save()", () => jobs.create("sendWelcome", bad).save()],
  [
    "a repeat series",
    () => jobs.schedule("sendWelcome").every("1 day").withData(bad).start(),
  ],
  [
    "a debounced add",
    () =>
      jobs.now("sendWelcome", bad, {
        debounce: { id: "welcome:ada", ttl: "1 minute" },
      }),
  ],
];
for (const [label, add] of sites) {
  await checkRejects(label, add, { code: "JOB_DATA_VALIDATION" });
}

checkEqual(
  "nothing was written: no job, no repeat series",
  [await stored(), (await registry.listRepeatables()).length],
  [0, 0],
);

/* ------------------------------------------------------------------ */
step("A job with no data is checked as null");

// What is checked is what is stored, and JSON has no `undefined`: a job added
// with no data is stored, and read back by every backend, as `null`.
jobs.define("rebuildIndexStrict", async () => {}, {
  schema: { data: z.object({ full: z.boolean() }) },
});
jobs.define("rebuildIndex", (job) => job.data === null, {
  // `.nullable()`, so the name can be added with no data at all.
  schema: { data: z.object({ full: z.boolean() }).nullable() },
});

await checkRejects(
  "no data, against a schema that does not accept null",
  () => jobs.now("rebuildIndexStrict"),
  { code: "JOB_DATA_VALIDATION", message: /: data: / },
);
const rebuild = await jobs.now("rebuildIndex");
check(
  "…and accepted by one that does (.nullable())",
  (await registry.getJob(rebuild.id)) !== null,
);

/* ------------------------------------------------------------------ */
step("Updates are checked too; addBulk is all or nothing");

const welcome = await jobs.now("sendWelcome", good);

await checkRejects(
  "job.updateData() with bad data",
  () => welcome.updateData(bad),
  { code: "JOB_DATA_VALIDATION" },
);
await checkRejects(
  "queue.update() with bad data",
  () => registry.update(welcome.id, { data: bad }),
  { code: "JOB_DATA_VALIDATION" },
);
checkEqual(
  "the job is unchanged",
  (await registry.getJob(welcome.id))?.data,
  good,
);

const bulk = await checkRejects(
  "addBulk() with one bad entry of three",
  () =>
    registry.addBulk([
      { name: "sendWelcome", data: good },
      { name: "sendWelcome", data: bad },
      { name: "sendWelcome", data: good },
    ]),
  { code: "JOB_DATA_VALIDATION" },
);
checkEqual(
  "the error names the entry",
  (bulk as JobDataValidationError | undefined)?.context.index,
  1,
);
checkEqual(
  "no entry was written, not even the first: still the two jobs above",
  await stored(),
  2,
);

/* ------------------------------------------------------------------ */
step(
  "In process, the handler gets the schema's output; the store keeps the input",
);

const registryWorker = await jobs.start({ pollInterval: 20 });

const done = await settle(registry, welcome.id, "completed");
const parsed = handed.get(welcome.id);
show("handed to the handler", parsed);
show("stored", done.data);
check(
  "signedUpAt arrived as a Date, plan with its default",
  parsed?.signedUpAt instanceof Date &&
    parsed.signedUpAt.toISOString() === good.signedUpAt &&
    parsed.plan === "free",
  parsed,
);
checkEqual("the stored data is what the producer sent", done.data, good);
checkEqual(
  "the no-data job ran, handed null",
  (await settle(registry, rebuild.id, "completed")).returnValue,
  true,
);

/* ------------------------------------------------------------------ */
step("On a worker thread, the output arrives through JSON");

/** A report: a number that may come as a string, and a moment. */
const Report = z.object({ n: z.coerce.number(), at: z.coerce.date() });

// A queue of its own takes `schema` in its own options; so does its worker.
const reports = jobs.queue("reports", { schema: { data: Report } });
void jobs
  .worker(
    "reports",
    new URL("./processors/report-arrival.ts", import.meta.url),
    {
      target: { kind: "worker-thread", closeTimeout: 200 },
      schema: { data: Report },
      pollInterval: 20,
    },
  )
  .run();

const at = "2026-10-21T10:00:00.000Z";
const report = await reports.add("report", { n: "7", at });
const arrival = (await settle(reports, report.id, "completed"))
  .returnValue as Arrival;
show("what the Worker received", arrival);
checkEqual(
  "the coercion arrived; the Date arrived as its ISO string",
  arrival,
  { data: { n: 7, at }, types: { n: "number", at: "string" } },
);
checkEqual(
  "the stored data is still the producer's",
  (await reports.getJob(report.id))?.data,
  { n: "7", at },
);

/* ------------------------------------------------------------------ */
step("Deploy skew: data added under an older schema dies, unretried");

// An older deployment of the same service, on the same store: its
// `sendWelcome` had no schema, and its jobs called the field `address`.
const older = new BunJobs({ namespace, driver, logger });
older.define("sendWelcome", async () => {}, { attempts: 5 });
const skewed = await older.now("sendWelcome", { address: SECRET });

const dead = await settle(registry, skewed.id, "dead");
show("failedReason", dead.failedReason?.message);
checkEqual(
  "straight to dead: one attempt of five, the handler never called",
  [dead.attemptsMade, dead.opts.attempts, handed.has(skewed.id)],
  [1, 5, false],
);
/** What the stored failure carries besides its message: its code and context. */
interface StoredFailure extends Error {
  /** The package's failure code. */
  code?: string;
  /** What the worker said about the job. */
  context?: {
    /** The definition whose schema refused it. */
    definition?: string;
    /** The issues, value-free. */
    issues?: { path: string }[];
  };
}
const failure: StoredFailure | null = dead.failedReason;
checkEqual(
  "an UnrecoverableJobError (UNRECOVERABLE_JOB)",
  [failure?.name, failure?.code],
  ["UnrecoverableJobError", "UNRECOVERABLE_JOB"],
);
const reason = failure?.message ?? "";
check(
  "its message names the job and the issues",
  reason.includes(skewed.id) &&
    reason.includes('"sendWelcome"') &&
    reason.includes("data.email") &&
    reason.includes("data.signedUpAt"),
  reason,
);
checkEqual(
  "its context names the definition and each issue's path",
  [
    failure?.context?.definition,
    failure?.context?.issues?.map((issue) => issue.path),
  ],
  ["sendWelcome", ["email", "signedUpAt"]],
);
check(
  "never the data",
  !JSON.stringify([dead.failedReason, dead.stacktrace]).includes(SECRET),
  dead.failedReason,
);
await older.close();

/* ------------------------------------------------------------------ */
step('resultValidation: "error" fails the attempt; "warn" logs one line');

/** A billing API whose ids became numbers, while this code still says strings. */
function createInvoice(): { invoiceId: string } {
  return JSON.parse('{ "invoiceId": 987654321 }') as { invoiceId: string };
}

/** The handler's answer must be `{ invoiceId: string }`. */
const Invoice = z.object({ invoiceId: z.string() });

jobs.define("issueInvoice", createInvoice, {
  attempts: 2,
  backoff: { type: "fixed", delay: 10 },
  schema: { result: Invoice },
  resultValidation: "error",
});
jobs.define("issueReceipt", createInvoice, {
  schema: { result: Invoice },
  resultValidation: "warn",
});

/** The registry worker's events for invoice jobs, in order. */
const invoiceEvents: string[] = [];
registryWorker.on("failed", (job, error) => {
  if (job.name === "issueInvoice") {
    invoiceEvents.push(`failed: ${error.name} (${error.message})`);
  }
});
registryWorker.on("completed", (job) => {
  if (job.name === "issueInvoice") invoiceEvents.push("completed");
});
const invoice = await jobs.now("issueInvoice");

const refusedInvoice = await settle(registry, invoice.id, "dead");
// The last attempt's `failed` event may follow the stored state by a moment.
await waitFor("the second attempt's failed event", () => {
  return invoiceEvents.length >= 2;
});
show("events", invoiceEvents);
checkEqual(
  "both attempts ran and failed; no completed event",
  [
    refusedInvoice.attemptsMade,
    invoiceEvents.length,
    invoiceEvents.includes("completed"),
  ],
  [2, 2, false],
);
check(
  "each failure a JobDataValidationError on the result",
  invoiceEvents.every((event) =>
    event.startsWith("failed: JobDataValidationError"),
  ) && invoiceEvents.every((event) => event.includes("result.invoiceId")),
  invoiceEvents,
);
checkEqual("nothing stored as its result", refusedInvoice.returnValue, null);

const receipt = await jobs.now("issueReceipt");
const receipted = await settle(registry, receipt.id, "completed");
const resultWarnings = warnings("Job result did not pass its schema");
checkEqual(
  '"warn": completed, with what the handler returned',
  receipted.returnValue,
  { invoiceId: 987654321 },
);
checkEqual("…and one warning", resultWarnings.length, 1);
show("the warning's fields", resultWarnings[0]?.fields);
check(
  "which carries the issues but not the value",
  !JSON.stringify(resultWarnings).includes("987654321"),
  resultWarnings,
);

/* ------------------------------------------------------------------ */
step('dataValidation per side: "warn" and "off"');

/** An import row: what a CSV upload produces. */
const Row = z.object({ sku: z.string().min(1), qty: z.coerce.number().int() });
/** A row no schema should pass: an empty sku, a quantity that is no number. */
const badRow = { sku: "", qty: SECRET };

/** What each import handler was handed, by queue. */
const imported: {
  /** Handed by the `"warn"` worker. */
  lenient: unknown[];
  /** Handed by the `"off"` worker. */
  unchecked: unknown[];
} = { lenient: [], unchecked: [] };

// Written anyway, with one warning at enqueue; run anyway, with one more.
const lenient = jobs.queue("imports-lenient", {
  schema: { data: Row },
  dataValidation: { enqueue: "warn" },
});
void jobs
  .worker(
    "imports-lenient",
    (job) => {
      imported.lenient.push(job.data);
    },
    {
      schema: { data: Row },
      dataValidation: { process: "warn" },
      pollInterval: 20,
    },
  )
  .run();

// Not checked at all, on either side.
const unchecked = jobs.queue("imports-unchecked", {
  schema: { data: Row },
  dataValidation: { enqueue: "off" },
});
void jobs
  .worker(
    "imports-unchecked",
    (job) => {
      imported.unchecked.push(job.data);
    },
    {
      schema: { data: Row },
      dataValidation: { process: "off" },
      pollInterval: 20,
    },
  )
  .run();

const lenientJob = await lenient.add("row", badRow);
const uncheckedJob = await unchecked.add("row", badRow);
await settle(lenient, lenientJob.id, "completed");
await settle(unchecked, uncheckedJob.id, "completed");

checkEqual(
  "both written and run, each handler handed the stored input",
  imported,
  { lenient: [badRow], unchecked: [badRow] },
);
const enqueueWarnings = warnings("written anyway");
const processWarnings = warnings("the processor gets the stored data");
checkEqual(
  '"warn": one warning at enqueue and one before the handler; "off": none',
  [enqueueWarnings.length, processWarnings.length],
  [1, 1],
);
checkEqual(
  "the warnings name the queue, not the value",
  [
    enqueueWarnings[0]?.fields?.queue,
    JSON.stringify([...enqueueWarnings, ...processWarnings]).includes(SECRET),
  ],
  ["imports-lenient", false],
);

/* ------------------------------------------------------------------ */
step("Over HTTP: 400 VALIDATION, the issues at data.<path>");

const api = createJobsApi({
  jobs,
  basePath: "/admin/jobs",
  authorize: () => true,
  // The defaults plus `jobs.add`, which the add route needs.
  actions: JOBS_API_ACTIONS.filter(
    (action) => !JOBS_API_OPT_IN_ACTIONS.has(action) || action === "jobs.add",
  ),
});
const adapter = new BunHttpAdapter(0);
adapter.use(api.basePath, api.router);

/** One request to the API, answered as status, parsed body (typed `T`) and raw text. */
async function call<T>(method: "GET" | "POST", path: string, body?: unknown) {
  const response = await adapter.fetch(`${api.basePath}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as T, text };
}

const before = await stored();
const rejected = await call<ProblemDto>("POST", "/queues/jobs/jobs", {
  name: "sendWelcome",
  data: bad,
});
show("POST /queues/jobs/jobs", rejected.body);
checkEqual(
  "400 VALIDATION, the issues where they sit in the body",
  [
    rejected.status,
    rejected.body.code,
    rejected.body.issues?.map((issue) => `${issue.target}:${issue.path}`),
  ],
  [400, "VALIDATION", ["body:data.email", "body:data.signedUpAt"]],
);
check("the response never quotes the value", !rejected.text.includes(SECRET));
checkEqual("and nothing was written", await stored(), before);

const accepted = await call("POST", "/queues/jobs/jobs", {
  name: "sendWelcome",
  data: good,
});
checkEqual("good data is added: 201", accepted.status, 201);

const listed = await call<DefinitionListDto>("GET", "/definitions");
const listedItem = listed.body.items.find(
  (item) => item.name === "sendWelcome",
);
checkEqual(
  "GET /definitions serves the plain options, never among them the schema",
  listedItem && { name: listedItem.name, options: listedItem.options },
  { name: "sendWelcome", options: { attempts: 5 } },
);
check(
  "and publishes the definition's JSON Schema (V5b)",
  listedItem?.schema?.data?.type === "object" &&
    typeof listedItem.schema.data.properties === "object",
  listedItem?.schema,
);

/* ------------------------------------------------------------------ */
step("Clean up");

await jobs.purge();
await jobs.close();
await driver.close();
summary();
