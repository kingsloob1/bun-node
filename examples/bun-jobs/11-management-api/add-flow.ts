/**
 * Adding a flow over HTTP: `POST /queues/:queue/flows`, which is
 * `BunQueue.addFlow` behind the management API, and workers running what it
 * added — children first, the parent last, reading its children's results.
 *
 * ```bash
 * bun 11-management-api/add-flow.ts
 * EXAMPLE_DRIVER=redis EXAMPLE_REDIS_URL=redis://localhost:6379/13 \
 *   bun 11-management-api/add-flow.ts
 * ```
 *
 * A flow is a job together with the jobs it waits on (its children), which
 * may have children of their own and may go in other queues of the same
 * namespace. The route takes one as a JSON tree and answers the tree it
 * added, in body order. Requests go through `adapter.fetch()`, with no socket.
 *
 * The points that are easy to get wrong:
 *
 * - **It is opt-in, as adding a job is.** The route exists only when
 *   `actions` names `jobs.add`, and never under `readOnly`: absent, it is the
 *   API's JSON 404, not a 403. `features.addFlow` in `/meta` says whether the
 *   backend can add flows, whatever `actions` and `readOnly` say.
 * - **`authorize` is asked once for every queue the flow writes to**, the
 *   path's first, and a refusal for any of them is a 403 naming that queue,
 *   with nothing written.
 * - **Everything is checked before anything is written.** At most
 *   `limits.maxFlowNodes` jobs (100, the top one included), nested at most
 *   `limits.maxFlowDepth` levels (10, the top is level 1), no `ignoreFailure`
 *   on the top job (it has no parent to carry on), no `queue:id` twice, and
 *   only the options `POST /queues/:queue/jobs` takes: each refusal is a 400
 *   `VALIDATION` with the path into the body. Only then are names checked.
 * - **Sending it again adds nothing.** With the top job's `jobId` already
 *   there, the answer is 200 with that job and no children.
 */
import type {
  JobDto,
  JobsApiAction,
  JobsApiAuthorizeContext,
  JobsApiConfig,
  MetaDto,
  ProblemDto,
} from "@kingsleyweb/bun-jobs";
// The request and response types of the wire contract, browser-safe.
import type {
  AddFlowBody,
  AddFlowResultDto,
} from "@kingsleyweb/bun-jobs/api/contract";
import process from "node:process";
import { BunHttpAdapter, createTestLogger } from "@kingsleyweb/bun-common";
import {
  BunJobs,
  createJobsApi,
  JOBS_API_ACTIONS,
  JOBS_API_OPT_IN_ACTIONS,
} from "@kingsleyweb/bun-jobs";
import { exampleDriver, exampleNamespace } from "../shared/backend";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";

title("The management API: adding a flow");

/** What a page of orders carries: which page, and how many lines it holds. */
interface Page {
  /** The page number. */
  page: number;
  /** The order lines on it. */
  lines: number;
}

/** What fetching a source returns: the lines it found, over how many pages. */
interface Fetched {
  /** Order lines, summed over the pages. */
  lines: number;
  /** How many pages were read. */
  pages: number;
}

/* ------------------------------------------------------------------ */
step("A context whose defined names the API will accept");

// The failing child's worker logs its failure; collected, not printed.
const { logger } = createTestLogger();

const jobs = new BunJobs({
  namespace: exampleNamespace("add-flow"),
  driver: exampleDriver(),
  logger,
});

// `addableNames` defaults to the names in `jobs.definitions()`: these are the
// names a flow body may use. The workers below do the actual work.
for (const name of [
  "monthly-report",
  "fetch-orders",
  "fetch-page",
  "fetch-refunds",
]) {
  jobs.define(name, async () => {});
}

/** The default actions plus `jobs.add`, which the flow route needs. */
const ADD_ACTIONS: JobsApiAction[] = JOBS_API_ACTIONS.filter(
  (action) => !JOBS_API_OPT_IN_ACTIONS.has(action) || action === "jobs.add",
);

/** The queue `authorize` refuses `jobs.add` on, for everyone. */
const LOCKED_QUEUE = "billing";

/** Every `jobs.add` question `authorize` was asked, as its queue. */
const addAsked: string[] = [];

/** An API over `jobs` at `/admin/jobs`, on an adapter of its own, and a way to call it. */
function mount(config: Partial<JobsApiConfig> = {}) {
  const api = createJobsApi({
    jobs,
    basePath: "/admin/jobs",
    // Everything is allowed but adding to the locked queue.
    authorize: (_req, context: JobsApiAuthorizeContext) => {
      if (context.action === "jobs.add") {
        addAsked.push(context.queue ?? "(none)");
      }
      return !(context.action === "jobs.add" && context.queue === LOCKED_QUEUE);
    },
    ...config,
  });
  const adapter = new BunHttpAdapter(0);
  adapter.use(api.basePath, api.router);

  /** One request, answered as status and parsed body. A write is sent as JSON. */
  async function call(method: "GET" | "POST", path: string, body?: unknown) {
    const response = await adapter.fetch(`${api.basePath}${path}`, {
      method,
      ...(method === "GET"
        ? {}
        : { headers: { "content-type": "application/json" } }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as any };
  }

  /** Whether this API registered the flow route. */
  const hasFlowRoute = () =>
    api.routes.some((route) => route.operationId === "addFlow");

  return { api, adapter, call, hasFlowRoute };
}

/** A small flow, for asking whether the route is there at all. */
const SMALL: AddFlowBody = { name: "monthly-report", data: {} };

/* ------------------------------------------------------------------ */
step("1. Opt-in: absent by default and under readOnly");

const plain = mount();
const plainAnswer = await plain.call("POST", "/queues/reports/flows", SMALL);
checkEqual(
  "the default API has no addFlow route: 404 ROUTE_NOT_FOUND",
  [plain.hasFlowRoute(), plainAnswer.status, plainAnswer.body.code],
  [false, 404, "ROUTE_NOT_FOUND"],
);

const readOnly = mount({ actions: ADD_ACTIONS, readOnly: true });
const readOnlyAnswer = await readOnly.call(
  "POST",
  "/queues/reports/flows",
  SMALL,
);
checkEqual(
  "readOnly removes it even with jobs.add in actions: 404 ROUTE_NOT_FOUND",
  [readOnly.hasFlowRoute(), readOnlyAnswer.status, readOnlyAnswer.body.code],
  [false, 404, "ROUTE_NOT_FOUND"],
);
checkEqual(
  "and neither 404 was asked of authorize, or wrote a queue",
  [addAsked, await jobs.listQueues()],
  [[], []],
);

/* ------------------------------------------------------------------ */
step("2. /meta: features.addFlow and the two limits");

const panel = mount({ actions: ADD_ACTIONS });
const meta: MetaDto = (await panel.call("GET", "/meta")).body;
show("driver", meta.driver.name);
show("features.addFlow", meta.features.addFlow);
show("limits", {
  maxFlowNodes: meta.limits.maxFlowNodes,
  maxFlowDepth: meta.limits.maxFlowDepth,
});
checkEqual(
  "limits.maxFlowNodes is 100 and limits.maxFlowDepth 10",
  [meta.limits.maxFlowNodes, meta.limits.maxFlowDepth],
  [100, 10],
);
checkEqual(
  "features.addFlow is the backend's alone: the same on the default and readOnly APIs",
  await Promise.all(
    [plain, readOnly].map(
      async (served) =>
        ((await served.call("GET", "/meta")).body as MetaDto).features.addFlow,
    ),
  ),
  [meta.features.addFlow, meta.features.addFlow],
);

/** Closes every API opened here, their adapters, and the context. */
async function closeAll(): Promise<void> {
  for (const served of [plain, readOnly, panel]) {
    await served.api.close();
    await served.adapter.close();
  }
  await jobs.purge();
  await jobs.close();
}

if (!meta.features.addFlow) {
  // A backend without the driver methods a flow needs (`recordChild`,
  // `requeueParent`, `markChildRecorded`). Every driver bun-jobs ships has
  // them; a custom one may not. Then even opted in, the route is not
  // registered, so there is nothing more to show here.
  show(`${meta.driver.name} cannot add flows; the route is absent`);
  const absent = await panel.call("POST", "/queues/reports/flows", SMALL);
  checkEqual(
    "without the flow methods the opted-in API has no addFlow route: 404 ROUTE_NOT_FOUND",
    [panel.hasFlowRoute(), absent.status, absent.body.code],
    [false, 404, "ROUTE_NOT_FOUND"],
  );
  await closeAll();
  summary();
  process.exit();
}

/* ------------------------------------------------------------------ */
step("3. A flow three levels deep, across two queues");

/** The top job's id; every other id but the pages' is given too. */
const REPORT_ID = "report-2026-09";

/**
 * A report waiting on two fetches in the `fetch` queue: orders, itself
 * waiting on two pages (which go in their parent's queue), and refunds,
 * which fails but is marked `ignoreFailure`, so the report carries on.
 */
const flow: AddFlowBody = {
  name: "monthly-report",
  data: { month: "2026-09" },
  opts: { jobId: REPORT_ID, priority: 2 },
  children: [
    {
      name: "fetch-orders",
      data: { source: "orders" },
      queue: "fetch",
      opts: { jobId: "orders-2026-09" },
      children: [
        { name: "fetch-page", data: { page: 1, lines: 3 } satisfies Page },
        { name: "fetch-page", data: { page: 2, lines: 4 } satisfies Page },
      ],
    },
    {
      name: "fetch-refunds",
      data: { source: "refunds" },
      queue: "fetch",
      opts: { jobId: "refunds-2026-09", attempts: 1, ignoreFailure: true },
    },
  ],
};

addAsked.length = 0;
const added = await panel.call("POST", "/queues/reports/flows", flow);
const tree: AddFlowResultDto = added.body;

/** A result tree as `queue:id state added=…` lines, indented by level. */
function outline(node: AddFlowResultDto, depth = 0): string[] {
  return [
    `${"  ".repeat(depth)}${node.job.queue}:${node.job.id} ${node.job.state} added=${node.added}`,
    ...node.children.flatMap((child) => outline(child, depth + 1)),
  ];
}
show("POST /queues/reports/flows", added.status);
show(outline(tree).join("\n"));

const [orders, refunds] = tree.children as [AddFlowResultDto, AddFlowResultDto];
const pageIds = orders.children.map((page) => page.job.id);

checkEqual(
  "201; every job added, in body order, each in its queue; parents waiting-children, leaves waiting",
  [added.status, outline(tree).map((line) => line.trim())],
  [
    201,
    [
      `reports:${REPORT_ID} waiting-children added=true`,
      "fetch:orders-2026-09 waiting-children added=true",
      `fetch:${pageIds[0]} waiting added=true`,
      `fetch:${pageIds[1]} waiting added=true`,
      "fetch:refunds-2026-09 waiting added=true",
    ],
  ],
);
checkEqual(
  "the jobs come back with their name, data and options: the report's priority, the pages' data in body order, refunds' ignoreFailure",
  [
    tree.job.name,
    tree.job.data,
    tree.job.priority,
    orders.children.map((page) => page.job.data),
    refunds.job.opts?.ignoreFailure,
  ],
  [
    "monthly-report",
    { month: "2026-09" },
    2,
    [
      { page: 1, lines: 3 },
      { page: 2, lines: 4 },
    ],
    true,
  ],
);
check(
  "the pages, given no jobId, were given distinct ids",
  pageIds.length === 2 && pageIds[0] !== pageIds[1],
  pageIds,
);
checkEqual(
  "authorize was asked about jobs.add once per queue, the path's first",
  addAsked,
  ["reports", "fetch"],
);

/* ------------------------------------------------------------------ */
step("4. Sending it again: 200, the existing top job, nothing added");

const again = await panel.call("POST", "/queues/reports/flows", {
  ...flow,
  data: { month: "changed" },
});
/** How many jobs a queue holds, in any state. */
const total = async (queue: string) =>
  Object.values(await jobs.queue(queue).count()).reduce((a, b) => a + b, 0);
checkEqual(
  "200, added false, the stored data, no children; still one job in reports and four in fetch",
  [
    again.status,
    again.body.added,
    again.body.job.data,
    again.body.children,
    await total("reports"),
    await total("fetch"),
  ],
  [200, false, { month: "2026-09" }, [], 1, 4],
);

/* ------------------------------------------------------------------ */
step("5. Workers: children first, then the parent, reading their results");

/** Each job as its processor starts, as `name` or `name page`. */
const runs: string[] = [];

/** What the report's processor read, to check below. */
let seen:
  | {
      /** `getChildrenValues()`: completed children's results, by `queue:id`. */
      values: Record<string, unknown>;
      /** `getChildrenFailures()`: ignored failures, by `queue:id`, as messages. */
      failures: Record<string, string>;
    }
  | undefined;

/** What `fetch-orders` read from its pages. */
let ordersSaw: Record<string, unknown> = {};

const fetchWorker = jobs.worker(
  "fetch",
  async (job) => {
    if (job.name === "fetch-page") {
      const { page, lines } = job.data as Page;
      runs.push(`fetch-page ${page}`);
      return { lines, pages: 1 } satisfies Fetched;
    }
    runs.push(job.name);
    if (job.name === "fetch-refunds") {
      throw new Error("the refunds service is down");
    }
    // fetch-orders: runs once both pages completed, and sums them.
    ordersSaw = await job.getChildrenValues();
    const pages = Object.values(ordersSaw) as Fetched[];
    return {
      lines: pages.reduce((sum, page) => sum + page.lines, 0),
      pages: pages.length,
    } satisfies Fetched;
  },
  { pollInterval: 25 },
);
const reportWorker = jobs.worker(
  "reports",
  async (job) => {
    runs.push(job.name);
    const values = await job.getChildrenValues();
    const failures = Object.fromEntries(
      Object.entries(await job.getChildrenFailures()).map(([key, error]) => [
        key,
        error.message,
      ]),
    );
    seen = { values, failures };
    const fetched = values["fetch:orders-2026-09"] as Fetched;
    return { month: (job.data as { month: string }).month, ...fetched };
  },
  { pollInterval: 25 },
);
// `run()` resolves only when a worker closes, so they are kept, not awaited.
const running = [fetchWorker.run(), reportWorker.run()];

// Completed or dead: a final state either way, so a broken flow fails the
// checks below rather than a timeout here.
await waitFor("the report to finish", async () => {
  const job = await jobs.queue("reports").getJob(REPORT_ID);
  return job?.state === "completed" || job?.state === "dead";
});

show("runs, in order", runs);
check(
  "both pages ran before orders, orders and refunds before the report, the report last",
  runs.length === 5 &&
    runs.indexOf("fetch-orders") > runs.indexOf("fetch-page 1") &&
    runs.indexOf("fetch-orders") > runs.indexOf("fetch-page 2") &&
    runs.at(-1) === "monthly-report",
  runs,
);
checkEqual(
  "orders read its pages' results from getChildrenValues(), keyed queue:id",
  ordersSaw,
  {
    [`fetch:${pageIds[0]}`]: { lines: 3, pages: 1 },
    [`fetch:${pageIds[1]}`]: { lines: 4, pages: 1 },
  },
);
show("the report read", seen);
checkEqual(
  "the report read orders' result as a value and refunds' ignored failure as a failure",
  seen,
  {
    values: { "fetch:orders-2026-09": { lines: 7, pages: 2 } },
    failures: { "fetch:refunds-2026-09": "the refunds service is down" },
  },
);

const report: JobDto = (
  await panel.call(
    "GET",
    `/queues/reports/jobs/${REPORT_ID}?include=returnValue`,
  )
).body;
const refundsJob: JobDto = (
  await panel.call("GET", "/queues/fetch/jobs/refunds-2026-09")
).body;
checkEqual(
  "through the API: the report completed with its result; refunds dead",
  [report.state, report.returnValue, refundsJob.state],
  ["completed", { month: "2026-09", lines: 7, pages: 2 }, "dead"],
);

/* ------------------------------------------------------------------ */
step("6. Refused before anything is written: 400 VALIDATION, with paths");

/** A flow of `count` jobs: a top job with `count - 1` children. */
function wide(count: number): AddFlowBody {
  return {
    name: "fetch-page",
    data: {},
    children: Array.from({ length: count - 1 }, (_, page) => ({
      name: "fetch-page",
      data: { page },
    })),
  };
}

/** A flow `levels` deep: each job the only child of the one above. */
function deep(levels: number): AddFlowBody {
  let node: AddFlowBody = { name: "fetch-page", data: { level: levels } };
  for (let level = levels - 1; level >= 1; level--) {
    node = { name: "fetch-page", data: { level }, children: [node] };
  }
  return node;
}

/** Posts a body to the `drafts` queue; answers the status, code and issues. */
async function refusal(body: unknown) {
  const { status, body: problem } = await panel.call(
    "POST",
    "/queues/drafts/flows",
    body,
  );
  return {
    status,
    code: (problem as ProblemDto).code,
    issues: (problem as ProblemDto).issues?.map(
      (issue) => `${issue.path}: ${issue.message}`,
    ),
  };
}

checkEqual(
  "one job over maxFlowNodes (101): refused at the 101st job",
  await refusal(wide(101)),
  {
    status: 400,
    code: "VALIDATION",
    issues: ["children.99: A flow may hold at most 100 jobs"],
  },
);
checkEqual(
  "one level over maxFlowDepth (11): refused at the 11th level",
  await refusal(deep(11)),
  {
    status: 400,
    code: "VALIDATION",
    issues: [
      `${Array.from({ length: 10 }).fill("children.0").join(".")}: A flow may nest at most 10 levels`,
    ],
  },
);
checkEqual(
  "ignoreFailure on the top job: it has no parent to carry on",
  await refusal({
    name: "monthly-report",
    data: {},
    opts: { ignoreFailure: true },
  }),
  {
    status: 400,
    code: "VALIDATION",
    issues: [
      "opts.ignoreFailure: The top job of a flow has no parent to carry on without it",
    ],
  },
);
checkEqual(
  "an option POST …/jobs does not take either (repeat), at its path",
  await refusal({
    name: "monthly-report",
    data: {},
    children: [
      { name: "fetch-page", data: {}, opts: { repeat: { every: 1000 } } },
    ],
  }),
  {
    status: 400,
    code: "VALIDATION",
    issues: ["children.0.opts.repeat: Unknown property"],
  },
);
const twice = await refusal({
  name: "monthly-report",
  data: {},
  children: [
    { name: "fetch-page", data: {}, opts: { jobId: "p1" } },
    {
      name: "fetch-orders",
      data: {},
      children: [{ name: "fetch-page", data: {}, opts: { jobId: "p1" } }],
    },
  ],
});
checkEqual(
  "one queue:id twice: both places named",
  [twice.status, twice.issues?.map((issue) => issue.split(":")[0])],
  [400, ["children.0.opts.jobId", "children.1.children.0.opts.jobId"]],
);
checkEqual(
  "none of those wrote anything: drafts does not exist",
  (await jobs.listQueues()).includes("drafts"),
  false,
);

/** Adds a body to the `bounds` queue, which no worker reads; answers the status. */
const accepted = async (body: AddFlowBody) =>
  (await panel.call("POST", "/queues/bounds/flows", body)).status;
checkEqual(
  "exactly at the limits is accepted: 100 jobs, and 10 levels",
  [await accepted(wide(100)), await accepted(deep(10))],
  [201, 201],
);

/* ------------------------------------------------------------------ */
step("7. Refused by name, and by authorize");

const unnamed = await panel.call("POST", "/queues/drafts/flows", {
  name: "monthly-report",
  data: {},
  children: [
    {
      name: "fetch-orders",
      data: {},
      queue: "fetch",
      children: [{ name: "drop-tables", data: {} }],
    },
  ],
});
checkEqual(
  "a name the context does not define: 403 NAME_NOT_ADDABLE, with its queue and path",
  [unnamed.status, unnamed.body.code, unnamed.body.context],
  [
    403,
    "NAME_NOT_ADDABLE",
    { name: "drop-tables", queue: "fetch", path: "children.0.children.0.name" },
  ],
);

addAsked.length = 0;
const locked = await panel.call("POST", "/queues/invoices/flows", {
  name: "monthly-report",
  data: {},
  children: [{ name: "fetch-orders", data: {}, queue: LOCKED_QUEUE }],
});
show(`a child in "${LOCKED_QUEUE}"`, {
  status: locked.status,
  code: locked.body.code,
  detail: locked.body.detail,
});
checkEqual(
  "authorize refuses one queue of the flow: 403 FORBIDDEN naming it",
  [locked.status, locked.body.code, locked.body.context],
  [403, "FORBIDDEN", { queue: LOCKED_QUEUE }],
);
checkEqual(
  "it was asked about both queues, and neither was written",
  [
    addAsked,
    (await jobs.listQueues()).filter((queue) =>
      ["invoices", LOCKED_QUEUE].includes(queue),
    ),
  ],
  [["invoices", LOCKED_QUEUE], []],
);

/* ------------------------------------------------------------------ */
step("Clean up");

await fetchWorker.close();
await reportWorker.close();
await Promise.all(running);
await closeAll();
summary();
