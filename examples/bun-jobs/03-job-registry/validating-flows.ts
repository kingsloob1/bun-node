/**
 * Validating flows — every node of `addFlow()` checked against its own name's
 * schema on its own queue, before anything is written, and a parent's
 * `getChildrenValues()` typed from the flow's declared shape.
 *
 * ```bash
 * bun 03-job-registry/validating-flows.ts
 * EXAMPLE_DRIVER=sqlite bun 03-job-registry/validating-flows.ts
 * ```
 *
 * `validating-job-data.ts` covers schemas on a single add. A flow is a tree
 * of adds, and each node is checked as an `add` of it would be: its name's
 * definition on the registry queue, else its queue's own `schema`, under that
 * queue's (or definition's) `dataValidation.enqueue` policy, the data's JSON
 * form, `null` for no data.
 *
 * Worth knowing:
 *
 * - **All nodes first, then the first write.** One node failing under
 *   `"error"` rejects the whole flow with `JobDataValidationError`, and no
 *   queue the flow touches gets a job. `context.flowPath` names the node: `""`
 *   for the top, `children.1.children.0` below it; `context.jobId` when the
 *   node gave one. The message names the job and the issues, never the value.
 * - **Which checks a node on another queue gets depends on what this process
 *   can see.** In a `BunJobs` context, a node on another queue the context
 *   created is checked with that queue's schema, and one on the registry
 *   queue with the definitions, even before the registry queue is created. A
 *   bare `BunQueue` checks its own nodes only; there the other queue's worker
 *   is what refuses the job, before its handler.
 * - **`"warn"` writes and logs once per node, `"off"` skips the node.** The
 *   warning names the node (`name`, `queue`, `flowPath`), never its data, and
 *   is logged only once every node has passed: a flow another node refuses
 *   writes nothing and warns about nothing.
 * - **A parent's children typed.** Declare the flow `as const` and
 *   `FlowChildrenValues<typeof flow, Jobs, "jobs">` derives what
 *   `getChildrenValues()` answers, keyed `queue:id`; put it in the parent's
 *   job-map entry as `children` and its `define()` handler is typed. A child
 *   with `ignoreFailure` (or `optional: true`) is `T | undefined`.
 * - **The parent's types are a claim.** Nothing checks the values again when
 *   the parent reads them: each child's result was checked at its own
 *   completion under its own `resultValidation`, `"off"` by default. Set it to
 *   `"error"` on a child (as `totals` does below) to make its entry a
 *   guarantee.
 * - **Over HTTP**, `POST /queues/:queue/flows` answers a refused node with 400
 *   `VALIDATION`, its issues at body paths: `children.0.data.to`.
 *
 * Every `@ts-expect-error` below is a live control: remove what it depends on
 * (the refunds child's `ignoreFailure`, say) and the type check fails.
 */
// The request and response types of the wire contract, browser-safe.
import type {
  AddFlowBody,
  ProblemDto,
} from "@kingsleyweb/bun-jobs/api/contract";
import type { FlowChildrenValues } from "@kingsleyweb/bun-jobs";
import { BunHttpAdapter, createTestLogger } from "@kingsleyweb/bun-common";
import {
  BunJobs,
  BunQueue,
  BunQueueWorker,
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

title("Job registry: validating flows");

/** `true` only when `A` and `B` are exactly the same type. */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

/** Compiles only when given `true` — a positive compile-time assertion. */
type Expect<T extends true> = T;

/**
 * Holds lines that must *not* compile, without ever running them. Only the
 * type check looks inside.
 */
function compileOnly(_controls: () => unknown): void {}

/**
 * A value that must never reach an error, a warning or a response: every bad
 * payload below carries it.
 */
const SECRET = "hunter2-not-an-email";

/** One driver for every context and bare queue here. */
const driver = createDriver(exampleDriver());

// Warnings are collected, so the checks can read them, instead of printed.
const { logger, events } = createTestLogger();

const jobs = new BunJobs({
  namespace: exampleNamespace("validating-flows"),
  driver,
  logger,
});

/** A month, `YYYY-MM`. */
const Month = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) });
/** One page of a source. */
const Page = z.object({ source: z.string(), page: z.number().int().min(1) });
/** Where an e-mail goes. */
const Email = z.object({ to: z.email() });

jobs.define("monthly-report", () => "sent", { schema: { data: Month } });
jobs.define("fetch-page", () => 3, { schema: { data: Page } });
jobs.define("send-email", () => {}, { schema: { data: Email } });

/** Anything with `count()`: a queue, bare or a context's. */
interface Countable {
  /** Jobs by state. */
  count: () => Promise<Record<string, number>>;
}

/** Every job, in every state, on `queue`. */
async function total(queue: Countable): Promise<number> {
  const counts = await queue.count();
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

/** Every job on each of `queues`, in order. */
async function totals(...queues: Countable[]): Promise<number[]> {
  return await Promise.all(queues.map(total));
}

/** The warnings logged so far whose message contains `text`. */
function warnings(text: string) {
  return events.filter(
    (event) => event.level === "warn" && event.message.includes(text),
  );
}

/** What `addFlow`'s data warning says. */
const WRITTEN_ANYWAY = "written anyway";

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

/** Checks a refusal is a `JobDataValidationError` and answers it, typed. */
function asDataError(error: Error | undefined): JobDataValidationError | null {
  if (error instanceof JobDataValidationError) return error;
  check("the error is a JobDataValidationError", false, error);
  return null;
}

/* ------------------------------------------------------------------ */
step("A flow refused at a grandchild: nothing written on any queue");

// Created before the flow, so the context knows it; it has no schema.
const archive = jobs.queue("archive");

/**
 * A report waiting on two pages and an archive job; the second page waits on
 * an e-mail to `to`.
 */
function reportFlow(to: string) {
  return {
    name: "monthly-report",
    data: { month: "2026-10" },
    opts: { jobId: "report-2026-10" },
    children: [
      { name: "fetch-page", data: { source: "orders", page: 1 } },
      {
        name: "fetch-page",
        data: { source: "orders", page: 2 },
        children: [
          { name: "send-email", data: { to }, opts: { jobId: "notify-ada" } },
        ],
      },
      { name: "archive-month", data: { month: "2026-10" }, queue: "archive" },
    ],
  };
}

const registry = jobs.queue("jobs");
const refused = asDataError(
  await checkRejects(
    "addFlow() with one bad grandchild",
    () => registry.addFlow(reportFlow(SECRET)),
    { name: "JobDataValidationError", code: "JOB_DATA_VALIDATION" },
  ),
);
show("the error", refused?.message);
show("its context", refused?.context);
checkEqual(
  "context names the node: its name, definition, flowPath and jobId",
  [
    refused?.context.name,
    refused?.context.definition,
    refused?.context.flowPath,
    refused?.context.jobId,
  ],
  ["send-email", "send-email", "children.1.children.0", "notify-ada"],
);
checkEqual(
  "the issues, by path",
  refused?.issues.map((issue) => issue.path),
  ["to"],
);
check(
  "and never the value",
  refused !== null &&
    !JSON.stringify([refused.message, refused]).includes(SECRET),
  refused?.message,
);
checkEqual(
  "nothing was written: not the report, the pages (registry) nor the archive job",
  await totals(registry, archive),
  [0, 0],
);

const added = await registry.addFlow(reportFlow("ada@example.com"));
checkEqual(
  "the same flow with a good address is added: four jobs on the registry, one on archive",
  [added.job.wasAdded, added.job.state, ...(await totals(registry, archive))],
  [true, "waiting-children", 4, 1],
);

/* ------------------------------------------------------------------ */
step("A node on another queue of the context gets that queue's schema");

// The parent's queue has no schema; the child's queue does.
const exports = jobs.queue("exports");
const mail = jobs.queue("mail", { schema: { data: Email } });

const crossQueue = await checkRejects(
  "a child on mail refused by mail's schema, though exports has none",
  () =>
    exports.addFlow({
      name: "export-csv",
      data: { rows: 10 },
      children: [{ name: "deliver", data: { to: SECRET }, queue: "mail" }],
    }),
  { code: "JOB_DATA_VALIDATION" },
);
const crossError = asDataError(crossQueue);
checkEqual(
  "the error names mail's queue and the child's path; no definition",
  [
    crossError?.context.queue,
    crossError?.context.flowPath,
    crossError?.context.definition,
  ],
  ["mail", "children.0", undefined],
);
checkEqual("nothing on exports or mail", await totals(exports, mail), [0, 0]);

// A context of its own, so its registry queue is not created yet: a node
// bound for it is checked with the definitions all the same.
const sibling = new BunJobs({
  namespace: exampleNamespace("validating-flows-sibling"),
  driver,
  logger,
});
sibling.define("fetch-page", () => 3, { schema: { data: Page } });
const siblingExports = sibling.queue("exports");
const early = await checkRejects(
  "a child bound for a registry queue not created yet: checked with its definition",
  () =>
    siblingExports.addFlow({
      name: "export-csv",
      data: { rows: 10 },
      children: [
        {
          name: "fetch-page",
          data: { source: "orders", page: 0 },
          queue: "jobs",
        },
      ],
    }),
  { code: "JOB_DATA_VALIDATION" },
);
const earlyError = asDataError(early);
checkEqual(
  "the error names the registry queue and the definition",
  [
    earlyError?.context.queue,
    earlyError?.context.definition,
    earlyError?.issues.map((issue) => issue.path),
  ],
  ["jobs", "fetch-page", ["page"]],
);
checkEqual(
  "nothing on exports or the registry queue",
  await totals(siblingExports, sibling.queue("jobs")),
  [0, 0],
);

/* ------------------------------------------------------------------ */
step("A bare BunQueue checks its own nodes only; the worker still checks");

const bareNamespace = exampleNamespace("validating-flows-bare");
const bareExports = new BunQueue("exports", {
  namespace: bareNamespace,
  driver,
  logger,
});
// The mail queue's schema, on its own bare queue and its worker: the exports
// queue above cannot see it.
const bareMail = new BunQueue("mail", {
  namespace: bareNamespace,
  driver,
  logger,
  schema: { data: Email },
});

const bareFlow = await bareExports.addFlow({
  name: "export-csv",
  data: { rows: 10 },
  opts: { jobId: "export-1" },
  children: [
    {
      name: "deliver",
      data: { to: SECRET },
      queue: "mail",
      opts: { jobId: "deliver-1" },
    },
  ],
});
checkEqual(
  "written: the bare exports queue cannot see mail's schema",
  [bareFlow.job.state, ...(await totals(bareExports, bareMail))],
  ["waiting-children", 1, 1],
);
await checkRejects(
  "bare mail's own add still checks with its schema",
  () => bareMail.add("deliver", { to: SECRET }),
  { code: "JOB_DATA_VALIDATION" },
);

/** Every job the bare mail worker's handler was handed. */
const delivered: unknown[] = [];
const mailWorker = new BunQueueWorker(
  "mail",
  (job) => {
    delivered.push(job.data);
  },
  {
    namespace: bareNamespace,
    driver,
    logger,
    schema: { data: Email },
    pollInterval: 20,
  },
);
void mailWorker.run();

const deadDelivery = await settle(bareMail, "deliver-1", "dead");
checkEqual(
  "the mail worker refused it before its handler: dead, unretried, an UnrecoverableJobError",
  [deadDelivery.failedReason?.name, deadDelivery.attemptsMade, delivered],
  ["UnrecoverableJobError", 1, []],
);
check(
  "its failure never quotes the value",
  !JSON.stringify(deadDelivery.failedReason).includes(SECRET),
  deadDelivery.failedReason,
);
const deadExport = await settle(bareExports, "export-1", "dead");
checkEqual(
  "and the parent fails with it: ChildFailedError",
  deadExport.failedReason?.name,
  "ChildFailedError",
);
await mailWorker.close();

/* ------------------------------------------------------------------ */
step('"warn" writes and warns once per node; "off" skips the node');

jobs.define("send-digest", () => {}, {
  schema: { data: Email },
  dataValidation: { enqueue: "warn" },
});
jobs.define("send-sms", () => {}, {
  schema: { data: z.object({ phone: z.string().regex(/^\+\d{7,15}$/) }) },
  dataValidation: { enqueue: "off" },
});

const warnedBefore = warnings(WRITTEN_ANYWAY).length;
const before = await total(registry);
await registry.addFlow({
  name: "monthly-report",
  data: { month: "2026-11" },
  children: [
    { name: "send-digest", data: { to: SECRET }, opts: { jobId: "digest-1" } },
    { name: "send-digest", data: { to: SECRET } },
    { name: "send-sms", data: { phone: SECRET } },
  ],
});
const flowWarnings = warnings(WRITTEN_ANYWAY).slice(warnedBefore);
show(
  "the warnings' fields",
  flowWarnings.map((event) => event.fields),
);
checkEqual("all four written", (await total(registry)) - before, 4);
checkEqual(
  "one warning per warn node, naming it (the off node: none)",
  flowWarnings.map((event) => [
    event.fields?.name,
    event.fields?.queue,
    event.fields?.flowPath,
    event.fields?.jobId,
  ]),
  [
    ["send-digest", "jobs", "children.0", "digest-1"],
    ["send-digest", "jobs", "children.1", undefined],
  ],
);
check(
  "never the value",
  !JSON.stringify(flowWarnings).includes(SECRET),
  flowWarnings,
);

// A "warn" node's warning says the job was written, so it is logged only once
// every node has passed: here a strict sibling refuses the flow, nothing is
// written, and the "warn" node logs nothing.
const warnedBeforeRefusal = warnings(WRITTEN_ANYWAY).length;
await checkRejects(
  'an "off" node is skipped, but a strict sibling still rejects the flow',
  () =>
    registry.addFlow({
      name: "monthly-report",
      data: { month: "2026-12" },
      children: [
        { name: "send-digest", data: { to: SECRET } },
        { name: "send-sms", data: { phone: SECRET } },
        { name: "fetch-page", data: { source: "orders", page: SECRET } },
      ],
    }),
  { code: "JOB_DATA_VALIDATION" },
);
checkEqual("and nothing more written", (await total(registry)) - before, 4);
checkEqual(
  'nor a "written anyway" warning from the "warn" node of the refused flow',
  warnings(WRITTEN_ANYWAY).length - warnedBeforeRefusal,
  0,
);

/* ------------------------------------------------------------------ */
step("A registry parent typed through FlowChildrenValues");

/**
 * The flow, declared once `as const` so its names, queue and ids stay
 * literals: the type below is derived from it, and the same object is added.
 */
const sendReport = {
  name: "send-report",
  data: { month: "2026-10" },
  opts: { jobId: "send-report-2026-10" },
  children: [
    {
      name: "totals",
      data: { month: "2026-10" },
      opts: { jobId: "totals-2026-10" },
    },
    {
      name: "refunds",
      data: { month: "2026-10" },
      opts: { jobId: "refunds-2026-10", attempts: 1, ignoreFailure: true },
    },
  ],
} as const;

/** The jobs of the reporting service: the parent's entry declares `children`. */
interface ReportJobs {
  /** The month's sales total. */
  totals: { data: { month: string }; result: number };
  /** The month's refunds; may fail without failing the report. */
  refunds: { data: { month: string }; result: { count: number } };
  /** The report, reading both children's results. */
  "send-report": {
    /** Which month. */
    data: { month: string };
    /** What was sent. */
    result: string;
    /** Its children's results, keyed `queue:id`, from the flow above. */
    children: FlowChildrenValues<typeof sendReport, ReportJobs, "jobs">;
  };
}

const reporting = new BunJobs<ReportJobs>({
  namespace: exampleNamespace("validating-flows-typed"),
  driver,
  logger,
});

// `totals` checks its own result, so its entry in the parent's values is a
// guarantee; `refunds` does not (`resultValidation` is `"off"` by default),
// so its entry is the map's claim.
reporting.define("totals", () => 1234, {
  schema: { result: z.number().int() },
  resultValidation: "error",
});
reporting.define(
  "refunds",
  () => {
    throw new Error("the refunds ledger is closed");
  },
  { attempts: 1 },
);

/** What the report's handler read from `getChildrenValues()`. */
let readValues: Record<string, unknown> | undefined;

reporting.define("send-report", async (job) => {
  const values = await job.getChildrenValues();
  readValues = values;
  // The record, derived from the flow: one key per child, `queue:id`.
  type _Values = Expect<
    Equal<
      typeof values,
      {
        "jobs:totals-2026-10": number;
        "jobs:refunds-2026-10": { count: number } | undefined;
      }
    >
  >;
  const sales = values["jobs:totals-2026-10"];
  compileOnly(() => {
    // @ts-expect-error refunds may be missing: its child may fail without failing this job
    void values["jobs:refunds-2026-10"].count;
    // @ts-expect-error totals is a number
    void (values["jobs:totals-2026-10"] satisfies string);
    // @ts-expect-error no child has this key
    void values["jobs:totals-2026-09"];
  });
  const refunds = values["jobs:refunds-2026-10"]?.count ?? "unknown";
  return `sales ${sales}, refunds ${refunds}`;
});

await reporting.start({ pollInterval: 20 });
const reportQueue = reporting.queue("jobs");
await reportQueue.addFlow(sendReport);

const report = await settle(reportQueue, "send-report-2026-10", "completed");
show("the parent read", readValues);
show("and returned", report.returnValue);
checkEqual(
  "totals' value is there; refunds failed, so its key is absent (undefined)",
  [readValues, readValues?.["jobs:refunds-2026-10"]],
  [{ "jobs:totals-2026-10": 1234 }, undefined],
);
checkEqual(
  "the parent ran without it",
  report.returnValue,
  "sales 1234, refunds unknown",
);
const failures = await (await reportQueue.getJob(
  "send-report-2026-10",
))!.getChildrenFailures();
checkEqual(
  "the ignored failure, from getChildrenFailures()",
  Object.keys(failures),
  ["jobs:refunds-2026-10"],
);

/* ------------------------------------------------------------------ */
step("Over HTTP: 400 VALIDATION, the issues at children.N.data.<path>");

const api = createJobsApi({
  jobs,
  basePath: "/admin/jobs",
  authorize: () => true,
  // The defaults plus `jobs.add`, which the flows route needs.
  actions: JOBS_API_ACTIONS.filter(
    (action) => !JOBS_API_OPT_IN_ACTIONS.has(action) || action === "jobs.add",
  ),
});
const adapter = new BunHttpAdapter(0);
adapter.use(api.basePath, api.router);

/** Posts a flow to `queue`, answered as status, parsed body and raw text. */
async function postFlow(queue: string, body: AddFlowBody) {
  const response = await adapter.fetch(
    `${api.basePath}/queues/${queue}/flows`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const text = await response.text();
  return {
    status: response.status,
    body: JSON.parse(text) as ProblemDto,
    text,
  };
}

const beforeHttp = await totals(registry, mail);
const answered = await postFlow("jobs", {
  name: "monthly-report",
  data: { month: "2026-10" },
  children: [
    { name: "send-email", data: { to: SECRET } },
    {
      name: "fetch-page",
      data: { source: "orders", page: 1 },
      children: [{ name: "send-email", data: { to: SECRET } }],
    },
  ],
});
show("POST /queues/jobs/flows", answered.body);
checkEqual(
  "400 VALIDATION collecting EVERY refused node's issue, each at its body path",
  [
    answered.status,
    answered.body.code,
    answered.body.issues?.map((issue) => `${issue.target}:${issue.path}`),
  ],
  [
    400,
    "VALIDATION",
    ["body:children.0.data.to", "body:children.1.children.0.data.to"],
  ],
);
const deep = await postFlow("jobs", {
  name: "monthly-report",
  data: { month: "2026-10" },
  children: [
    { name: "fetch-page", data: { source: "orders", page: 1 } },
    {
      name: "fetch-page",
      data: { source: "orders", page: 2 },
      children: [{ name: "send-email", data: { to: SECRET } }],
    },
  ],
});
checkEqual(
  "a grandchild's issue: children.1.children.0.data.to",
  [deep.status, deep.body.issues?.map((issue) => issue.path)],
  [400, ["children.1.children.0.data.to"]],
);
check(
  "neither response quotes the value",
  !answered.text.includes(SECRET) && !deep.text.includes(SECRET),
);
checkEqual("nothing written", await totals(registry, mail), beforeHttp);

/* ------------------------------------------------------------------ */
step("Clean up");

await api.close();
await adapter.close();
await bareExports.close();
await bareMail.close();
await driver.purge(bareNamespace);
await sibling.purge();
await sibling.close();
await reporting.purge();
await reporting.close();
await jobs.purge();
await jobs.close();
await driver.close();
summary();
