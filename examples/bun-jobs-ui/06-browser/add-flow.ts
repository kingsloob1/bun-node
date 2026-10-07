/**
 * The queue screen's **Add flow** dialog in a real browser, against a real
 * `createJobsApi`: a job and the jobs it waits on, each in its parent's queue
 * or one of its own, sent as one `POST /queues/:queue/flows`. Every result
 * is read back through the API or the store, not only from the page.
 *
 * ```bash
 * bun 06-browser/add-flow.ts
 * BUN_CHROME_PATH=/opt/chrome/chrome bun 06-browser/add-flow.ts
 * EXAMPLE_BROWSER=0 bun 06-browser/add-flow.ts   # skip on purpose
 * ```
 *
 * Like the other browser examples it drives headless Chrome through
 * `Bun.WebView` and **skips** (prints `skipped:` and exits 0) when there is
 * no `Bun.WebView`, no Chrome, or Chrome will not start.
 *
 * What it shows:
 *
 * - **The button's gates.** "Add flow" sits in the queue toolbar beside
 *   "Add job", and only where Add job is offered (`jobs.add`, not
 *   `readOnly`, some name addable) **and** `/meta`'s `features.addFlow` is
 *   true. That flag is the backend's capability alone: a read-only API, and
 *   one without the opt-in `jobs.add` in `actions`, still report it `true`,
 *   and the button is hidden there by the `jobs.add` gate. A driver without
 *   the methods `BunQueue.addFlow` needs (`requeueParent` hidden here)
 *   reports it `false`: Add job stays, Add flow goes.
 * - **A flow across queues.** The top job goes in the screen's queue; a
 *   child goes in its parent's queue, one the caller can list, or any name
 *   typed under "Another queue…". Once added, the dialog lists every job
 *   with its queue and id; the top job is `waiting-children` until they
 *   complete.
 * - **A child queue the caller may not add to.** The dialog asks each other
 *   queue's own permissions map (`GET /meta/permissions?queue=`) and marks
 *   a child going to a refused one (`data-refused` on its
 *   `fieldset[data-testid="flow-node"]`, and a message under its Queue
 *   field), but still lets the API decide: the flow goes out, the API
 *   answers 403 `FORBIDDEN` naming the queue in `context.queue`, nothing is
 *   written, and the dialog puts the refusal on the Queue field of every job
 *   going there (the child, and its own child taking its parent's queue) and
 *   keeps the tree as typed.
 * - **A refusal lasts while its queue does.** The API's message shows only
 *   while the job still goes where it was sent. Editing the child's data
 *   keeps it; retyping the child's queue drops it, from the child and from
 *   its child that follows it, before anything is sent. Add flow then adds
 *   the flow.
 * - **Checked before sending.** A job with no name is not sent; Add child
 *   is disabled at `limits.maxFlowDepth` (10) with the reason beside it, and
 *   Remove takes a node with everything below it.
 * - **Wait on conditions, never on time.** Every page-side helper polls the
 *   DOM until what it wants is there, and every API check polls the API.
 */
import type {
  JobDto,
  JobsApiAuthorize,
  JobsDriver,
  MetaDto,
  ProblemDto,
} from "@kingsleyweb/bun-jobs";
import type {
  AddFlowBody,
  PermissionsDto,
} from "@kingsleyweb/bun-jobs/api/contract";
import { BunHttpAdapter, noopLogger } from "@kingsleyweb/bun-common";
import {
  BunJobs,
  createJobsApi,
  JOBS_API_ACTIONS,
  MemoryDriver,
} from "@kingsleyweb/bun-jobs";
import { jobsUi } from "@kingsleyweb/bun-jobs-ui";
import {
  button,
  chromeOrSkip,
  openView,
  textOf,
  waitForSelector,
} from "../shared/browser";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";
import { buttonsIn, poll } from "./helpers/page";

// Decide whether to skip before printing anything: run-all.ts recognises a
// skip by the output *starting* with `skipped:`.
const chromePath = chromeOrSkip();

/** The CSRF header the APIs ask for on a mutation; the UI reads its name from `api.info`. */
const CSRF = "x-bun-jobs-csrf";
/** The screen's queue: every flow's top job goes here. */
const REPORTS = "reports";
/** A second queue, with a job in it so the child's Queue select lists it. */
const WAREHOUSE = "warehouse";
/** A queue this caller may not add jobs to: `authorize` refuses `jobs.add` on it. */
const PAYROLL = "payroll";
/** A queue nobody has used yet, typed in to fix the refused child. */
const ARCHIVE = "archive";
/** The only names the APIs accept, so the Name field is a select of them. */
const NAMES = ["build-report", "count-stock", "total-sales"];
/** The job already in `reports`, whose row says the screen has its permissions. */
const SEED_REPORT = "existing-report";
/** The job already in `warehouse`. */
const SEED_STOCK = "existing-stock";
/** What the dialog says beside a child whose queue refuses `jobs.add`, before sending. */
const PRECHECK = `You may not add jobs to “${PAYROLL}”: the API will refuse this flow.`;
/** What it says on that child once the API has refused the flow. */
const REFUSED = `You may not add jobs to “${PAYROLL}”.`;
/** The data of the refused child's own child, which takes its parent's queue. */
const GRANDCHILD_DATA = '{"site":"south"}';
/** The refused child's data once edited, after the refusal. */
const EDITED_DATA = '{"region":"apac"}';

/* --- the server: one host, four API + UI pairs ---------------------- */

const jobs = new BunJobs({
  namespace: "examples-ui-add-flow",
  driver: new MemoryDriver(),
  logger: noopLogger,
});

/**
 * The same driver with some optional methods hidden, as a driver written
 * before them would be. Methods are bound to the real driver so its private
 * state still works.
 */
function without(real: JobsDriver, methods: (keyof JobsDriver)[]): JobsDriver {
  return new Proxy(real, {
    get(target, property) {
      if (methods.includes(property as keyof JobsDriver)) {
        return undefined;
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * A context whose driver lacks `requeueParent`, one of the three methods
 * `BunQueue.addFlow` needs, so its API reports `features.addFlow: false`.
 */
const noFlowJobs = new BunJobs({
  namespace: "examples-ui-add-flow-noflow",
  driver: without(new MemoryDriver(), ["requeueParent"]),
  logger: noopLogger,
});

/** How often `authorize` was asked about `jobs.add` on `payroll` (and refused it). */
let payrollRefusals = 0;

/** Everything is allowed, except adding jobs to `payroll`. */
const authorize: JobsApiAuthorize = (_req, ctx) => {
  if (ctx.action === "jobs.add" && ctx.queue === PAYROLL) {
    payrollRefusals++;
    return { allow: false, reason: `jobs of ${PAYROLL}` };
  }
  return true;
};

/** What every API here shares. */
const common = {
  authorize,
  csrf: { header: CSRF },
  addableNames: NAMES,
  limits: { queueCacheMs: 0 },
  logger: noopLogger,
} as const;

/** Every action, the opt-in `jobs.add` included: Add flow is offered. */
const full = createJobsApi({
  ...common,
  jobs,
  basePath: "/jobs-api",
  actions: [...JOBS_API_ACTIONS],
});
/** The same actions, read-only: the mutations, `jobs.add` among them, are pruned. */
const readOnly = createJobsApi({
  ...common,
  jobs,
  basePath: "/ro-api",
  readOnly: true,
  actions: [...JOBS_API_ACTIONS],
});
/** `actions` left out: every action but the opt-ins, so `jobs.add` is not routed. */
const noAdd = createJobsApi({
  ...common,
  jobs,
  basePath: "/noadd-api",
});
/** Every action, over the driver without `requeueParent`. */
const noFlow = createJobsApi({
  ...common,
  jobs: noFlowJobs,
  basePath: "/noflow-api",
  actions: [...JOBS_API_ACTIONS],
});

const uis = {
  full: jobsUi({ api: full, basePath: "/jobs", logger: noopLogger }),
  readOnly: jobsUi({ api: readOnly, basePath: "/ro", logger: noopLogger }),
  noAdd: jobsUi({ api: noAdd, basePath: "/noadd", logger: noopLogger }),
  noFlow: jobsUi({ api: noFlow, basePath: "/noflow", logger: noopLogger }),
};
const apis = [full, readOnly, noAdd, noFlow];

/** One request the page sent to the full API, as the host saw it and the API answered it. */
interface Exchange {
  /** The method. */
  method: string;
  /** The path under the API's base, without the query. */
  path: string;
  /** The query string, without the `?`. */
  query: string;
  /** The parsed request body, once the API has read it (`undefined` for none). */
  body: unknown;
  /** The status answered. */
  status: number;
  /** The parsed answer, for a JSON body. */
  json: unknown;
}

/** Every answered request to the full API, oldest first. */
const exchanges: Exchange[] = [];

const app = new BunHttpAdapter(0, { logger: noopLogger });
// Ahead of the APIs: records each request to the full one as it arrived and,
// through a response transform, what the API answered.
app.use((req, res, next) => {
  const url = new URL(req.originalUrl, "http://host");
  if (!url.pathname.startsWith(`${full.basePath}/`)) {
    next();
    return;
  }
  res.addResponseTransform({
    transform: (response, { body }) => {
      let json: unknown;
      try {
        json = typeof body === "string" ? JSON.parse(body) : undefined;
      } catch {
        json = undefined;
      }
      exchanges.push({
        method: req.method,
        path: url.pathname.slice(full.basePath.length),
        query: url.search.replace(/^\?/, ""),
        // By the time the answer is produced the API has parsed the body.
        body: req.body,
        status: response.status,
        json,
      });
      return response;
    },
  });
  next();
});
for (const api of apis) {
  app.use(api.basePath, api.router);
}
for (const ui of Object.values(uis)) {
  app.use(ui.basePath, ui.router);
}
await app.listen(0);
const origin = app.url!.replace(/\/$/, "");

/** Winds everything down; safe to call more than once. */
async function shutdown(view?: Bun.WebView): Promise<void> {
  view?.close();
  await app.close();
  for (const api of apis) {
    await api.close();
  }
  await noFlowJobs.close();
  await jobs.close();
}

// One job in each of the two queues the dialog lists, and one on the
// no-flow context, so each queue screen has a row to wait for.
await jobs
  .queue(REPORTS)
  .add("build-report", { month: "2026-08" }, { jobId: SEED_REPORT });
await jobs
  .queue(WAREHOUSE)
  .add("count-stock", { site: "north" }, { jobId: SEED_STOCK });
await noFlowJobs
  .queue(REPORTS)
  .add("build-report", { month: "2026-08" }, { jobId: SEED_REPORT });

// Build the bundle before the browser asks, so the first page load is not
// the in-memory build.
await (await fetch(`${origin}${uis.full.basePath}`)).arrayBuffer();

/* --- the browser: skip, not fail, if Chrome will not start --------- */

/** What the page printed to its console, for a failure's diagnosis. */
const pageConsole: string[] = [];
const view = await openView(chromePath, pageConsole, shutdown);

title("Add a flow from the queue screen, in Chrome");
show("Chrome", chromePath);
show("serving", `${origin}${uis.full.basePath}`);

/* --- page-side helpers: each resolves once its condition holds ----- */

/** Every node of the open dialog's flow, in body order (each before its children). */
const NODES = 'dialog[open] fieldset[data-testid="flow-node"]';
/** The queue screen's toolbar: Add job, Add flow and the queue's actions. */
const TOOLBAR = ".queue-toolbar";

/**
 * Page-side expression: the control labelled `label` (its required marker
 * ignored) inside the `index`-th flow node, or `null`. Only the node's own
 * fields: its children's are in fieldsets of their own, after it.
 */
function nodeControl(index: number, label: string): string {
  return `(() => {
    const node = document.querySelectorAll(${JSON.stringify(NODES)})[${index}];
    if (!node) return null;
    for (const element of node.querySelectorAll("label")) {
      const text = element.textContent.replace(/\\s*\\*$/, "").trim();
      if (text === ${JSON.stringify(label)} && element.htmlFor) {
        return document.getElementById(element.htmlFor);
      }
    }
    return null;
  })()`;
}

/**
 * Page-side: sets the control labelled `label` in node `index` to `value`
 * the way a user's edit reaches React (the native value setter, then
 * `change` for a select and `input` otherwise). A select is retried until it
 * offers `value`, since its options may still be loading. Resolves `true`,
 * or `null` after the deadline.
 */
function setNode(index: number, label: string, value: string): string {
  return poll(`(() => {
    const control = ${nodeControl(index, label)};
    if (!control) return null;
    const proto = control.tagName === "SELECT"
      ? HTMLSelectElement.prototype
      : control.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(control, ${JSON.stringify(value)});
    if (control.value !== ${JSON.stringify(value)}) return null;
    control.dispatchEvent(new Event(control.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
    return true;
  })()`);
}

/** One flow node as the dialog shows it. */
interface NodeView {
  /** Its legend: "Top job", "Child 1", "Child 1.2"… */
  label: string;
  /** `data-refused`: `"true"` on a node whose queue refuses `jobs.add`, else `null`. */
  refused: string | null;
  /** The Name select's value. */
  name: string | null;
  /** The Data editor's text. */
  data: string | null;
  /** The Queue select's value (`""` for its parent's); the top job's queue, as shown, for the top job. */
  queue: string | null;
  /** The "Another queue" input's value, or `null` while it is not shown. */
  otherQueue: string | null;
  /** Every field error shown in the node, in order. */
  errors: string[];
}

/** Page-side expression: every node of the open dialog, as {@link NodeView}s. */
const READ_TREE = `[...document.querySelectorAll(${JSON.stringify(NODES)})].map((node, index) => {
  const control = (label) => {
    for (const element of node.querySelectorAll("label")) {
      if (element.textContent.replace(/\\s*\\*$/, "").trim() === label && element.htmlFor) {
        return document.getElementById(element.htmlFor);
      }
    }
    return null;
  };
  return {
    label: node.querySelector("legend").textContent.trim(),
    refused: node.getAttribute("data-refused"),
    name: control("Name")?.value ?? null,
    data: control("Data")?.value ?? null,
    queue: index === 0
      ? node.querySelector(".flow-node-queue code")?.textContent.trim() ?? null
      : control("Queue")?.value ?? null,
    otherQueue: control("Another queue")?.value ?? null,
    errors: [...node.querySelectorAll(".field-error")].map((error) => error.textContent.trim()),
  };
})`;

/**
 * Page-side: the open dialog's nodes once `ready(tree)` holds (a page-side
 * expression over `tree`, an array of {@link NodeView}s); `null` after `ms`.
 */
function treeWhen(ready: string, ms = 15_000): string {
  return poll(
    `(() => {
      const tree = ${READ_TREE};
      return tree.length > 0 && (${ready}) ? tree : null;
    })()`,
    ms,
  );
}

/** What the dialog shows once a flow is added. */
interface ResultView {
  /** Its first paragraph: how many jobs, and which is the top one. */
  summary: string;
  /** Every job added, as `[name, queue, id]`, in body order. */
  jobs: [string, string, string][];
}

/** Page-side: the dialog's `flow-result`, once it shows; `null` after `ms`. */
function resultOf(ms = 15_000): string {
  return poll(
    `(() => {
      const result = document.querySelector('dialog[open] [data-testid="flow-result"]');
      if (!result) return null;
      return {
        summary: result.querySelector("p").textContent.replace(/\\s+/g, " ").trim(),
        jobs: [...result.querySelectorAll(".flow-result-list li")].map((item) => {
          const codes = item.querySelectorAll("code");
          return [item.querySelector("a").textContent.trim(), codes[0].textContent.trim(), codes[1].textContent.trim()];
        }),
      };
    })()`,
    ms,
  );
}

/**
 * Page-side: whether the disabled "Add child" button of node `label`
 * describes why, as `[disabled, reason]`, once the button exists.
 */
function addChildState(label: string): string {
  return poll(`(() => {
    for (const candidate of document.querySelectorAll("dialog[open] button")) {
      if (candidate.textContent.trim() === ${JSON.stringify(`Add child to ${label}`)}) {
        const id = candidate.getAttribute("aria-describedby");
        return [candidate.disabled, id ? document.getElementById(id)?.textContent.trim() ?? null : null];
      }
    }
    return null;
  })()`);
}

/** A JSON read from an API, bypassing the page. */
async function read<T>(base: string, path: string): Promise<T> {
  const response = await fetch(`${origin}${base}${path}`);
  return (await response.json()) as T;
}

/** One job, read through the full API. */
function readJob(queue: string, id: string): Promise<JobDto> {
  return read<JobDto>(
    full.basePath,
    `/queues/${queue}/jobs/${encodeURIComponent(id)}`,
  );
}

/** How many jobs each queue holds, read from the store. */
async function storeTotals(queues: string[]): Promise<Record<string, number>> {
  const totals: Record<string, number> = {};
  for (const queue of queues) {
    const counts = await jobs.queue(queue).count();
    totals[queue] = Object.values(counts).reduce(
      (sum: number, count) => sum + (typeof count === "number" ? count : 0),
      0,
    );
  }
  return totals;
}

/** The page's `POST …/flows` requests so far. */
function flowPosts(): Exchange[] {
  return exchanges.filter(
    (one) => one.method === "POST" && one.path === `/queues/${REPORTS}/flows`,
  );
}

/** Opens the full UI's `reports` screen and its Add flow dialog, with the first node's fields drawn. */
async function openDialog(): Promise<boolean> {
  await view.navigate(`${origin}${uis.full.basePath}/queues/${REPORTS}`);
  return (
    (await view.evaluate<boolean>(button(TOOLBAR, "Add flow", true))) &&
    (await view.evaluate<boolean>(waitForSelector(NODES)))
  );
}

/**
 * Runs page-side `steps` in order, stopping at the first that finds nothing
 * to act on. Resolves whether every one did.
 */
async function runSteps(steps: string[]): Promise<boolean> {
  for (const one of steps) {
    if ((await view.evaluate<boolean | null>(one)) !== true) {
      show("this step found nothing to act on", one.slice(0, 200));
      return false;
    }
  }
  return true;
}

/**
 * Fills a flow in the open dialog: the top job, then a child going to
 * `warehouse` (picked from the list) and a second child whose queue is
 * `secondQueue`, typed under "Another queue…" — or left as its parent's when
 * `secondQueue` is `""`. Resolves whether every field was found.
 */
async function buildFlow(secondQueue: string): Promise<boolean> {
  return runSteps([
    setNode(0, "Name", "build-report"),
    setNode(0, "Data", '{"month":"2026-09"}'),
    button(NODES, "Add child to Top job", true),
    setNode(1, "Name", "count-stock"),
    setNode(1, "Data", '{"site":"north"}'),
    setNode(1, "Queue", WAREHOUSE),
    button(NODES, "Add child to Top job", true),
    setNode(2, "Name", "total-sales"),
    setNode(2, "Data", '{"region":"emea"}'),
    ...(secondQueue === ""
      ? []
      : [
          setNode(2, "Queue", "\u0000other"),
          setNode(2, "Another queue", secondQueue),
        ]),
  ]);
}

/**
 * Reads a flow the dialog reported back through the API: the top job's
 * state, its pending count and whether its own flow record lists exactly the
 * jobs whose parent it is, then every other job's queue, name, state and
 * parent, as its index in the dialog's result (`0` for the top job, `-1` for
 * one not there).
 */
async function readFlow(result: ResultView | null): Promise<unknown> {
  const listed = result?.jobs ?? [];
  const [parent, ...children] = await Promise.all(
    listed.map(([, queue, id]) => readJob(queue, id)),
  );
  if (!parent) {
    return null;
  }
  /** Where `job`'s parent is in the dialog's result. */
  const parentOf = (job: JobDto): number =>
    listed.findIndex(
      ([, queue, id]) =>
        job.flow?.parent?.queue === queue && job.flow?.parent?.id === id,
    );
  return {
    top: [
      parent.queue,
      parent.name,
      parent.state,
      parent.flow?.pending,
      Bun.deepEquals(
        parent.flow?.children.map((ref) => `${ref.queue}:${ref.id}`).sort(),
        children
          .filter((child) => parentOf(child) === 0)
          .map((child) => `${child.queue}:${child.id}`)
          .sort(),
      ),
    ],
    children: children.map((child) => [
      child.queue,
      child.name,
      child.state,
      parentOf(child),
    ]),
  };
}

try {
  /* ---------------------------------------------------------------- */
  step("The button: offered beside Add job only where everything holds");

  /** What each host's `/meta` says about adding a flow. */
  const metas: Record<string, unknown> = {};
  for (const [name, api] of Object.entries({
    full,
    readOnly,
    noAdd,
    noFlow,
  })) {
    const meta = await read<MetaDto>(api.basePath, "/meta");
    metas[name] = [meta.features.addFlow, meta.readOnly, meta.addableNames];
  }
  show("GET /meta → [features.addFlow, readOnly, addableNames]", metas);
  checkEqual(
    "features.addFlow is the backend's capability: true read-only and without jobs.add, false only without requeueParent",
    metas,
    {
      full: [true, false, NAMES],
      readOnly: [true, true, []],
      noAdd: [true, false, []],
      noFlow: [false, false, NAMES],
    },
  );

  /** The toolbar's buttons on `ui`'s reports screen, once its seeded row (so its permissions) is in. */
  async function toolbar(ui: { basePath: string }): Promise<string[] | null> {
    await view.navigate(`${origin}${ui.basePath}/queues/${REPORTS}`);
    if (
      !(await view.evaluate<boolean>(
        waitForSelector(`[data-testid="job-row-${SEED_REPORT}"]`),
      ))
    ) {
      return null;
    }
    return view.evaluate<string[]>(buttonsIn(TOOLBAR));
  }

  const fullButtons = await toolbar(uis.full);
  show("the full API's toolbar", fullButtons);
  check(
    "jobs.add, not read-only, names addable and features.addFlow: Add job and Add flow are both offered",
    fullButtons?.includes("Add job") === true &&
      fullButtons.includes("Add flow"),
    { fullButtons, pageConsole },
  );
  const roButtons = await toolbar(uis.readOnly);
  check(
    "readOnly: neither Add job nor Add flow, though features.addFlow says true",
    roButtons !== null &&
      !roButtons.includes("Add job") &&
      !roButtons.includes("Add flow"),
    roButtons,
  );
  const noAddButtons = await toolbar(uis.noAdd);
  check(
    "jobs.add left out of actions: neither button",
    noAddButtons !== null &&
      !noAddButtons.includes("Add job") &&
      !noAddButtons.includes("Add flow"),
    noAddButtons,
  );
  const noFlowButtons = await toolbar(uis.noFlow);
  check(
    "a driver without requeueParent (features.addFlow false): Add job stays, Add flow goes",
    noFlowButtons?.includes("Add job") === true &&
      !noFlowButtons.includes("Add flow"),
    noFlowButtons,
  );
  const noFlowPost = await fetch(
    `${origin}${noFlow.basePath}/queues/${REPORTS}/flows`,
    {
      method: "POST",
      headers: { [CSRF]: "1", "Content-Type": "application/json" },
      body: JSON.stringify({ name: "build-report", data: {} }),
    },
  );
  checkEqual(
    "and there the route is not served at all: POST …/flows → 404",
    noFlowPost.status,
    404,
  );

  /* ---------------------------------------------------------------- */
  step("Checked before sending: a job with no name, the depth bound, Remove");

  check("Add flow opens the dialog", await openDialog(), pageConsole);
  checkEqual(
    "it starts with the top job alone, in the screen's queue",
    await view.evaluate<string | null>(textOf('[data-testid="flow-count"]')),
    "1 of 100 jobs, nested at most 10 levels.",
  );
  const postsBefore = flowPosts().length;
  check(
    "Add flow with no name picked",
    await view.evaluate<boolean>(button("dialog[open]", "Add flow", true)),
  );
  const unnamed = await view.evaluate<NodeView[] | null>(
    treeWhen("tree[0].errors.length > 0"),
  );
  checkEqual(
    "shows the error on the top job's Name, and nothing is sent",
    [unnamed?.[0]?.errors, flowPosts().length],
    [["Pick or enter a job name."], postsBefore],
  );

  // Ten levels: the top job, then a child of each newest child.
  let deepest = "Top job";
  for (let level = 2; level <= 10; level++) {
    await view.evaluate(button(NODES, `Add child to ${deepest}`, true));
    deepest = level === 2 ? "Child 1" : `${deepest}.1`;
  }
  show("the deepest node", deepest);
  checkEqual(
    "at level 10 Add child is disabled and says why; the top job may still take one",
    [
      await view.evaluate<[boolean, string | null] | null>(
        addChildState(deepest),
      ),
      await view.evaluate<[boolean, string | null] | null>(
        addChildState("Top job"),
      ),
      await view.evaluate<string | null>(textOf('[data-testid="flow-count"]')),
    ],
    [
      [true, "This job is at level 10; a flow nests at most 10 levels."],
      [false, null],
      "10 of 100 jobs, nested at most 10 levels.",
    ],
  );
  check(
    "Remove Child 1",
    await view.evaluate<boolean>(button(NODES, "Remove Child 1", true)),
  );
  checkEqual(
    "takes it with the eight jobs below it",
    (await view.evaluate<NodeView[] | null>(treeWhen("tree.length === 1")))
      ?.length,
    1,
  );
  check(
    "Cancel closes the dialog",
    (await view.evaluate<boolean>(button("dialog[open]", "Cancel", true))) &&
      (await view.evaluate<boolean>(
        poll(`!document.querySelector(${JSON.stringify(NODES)})`),
      )),
  );
  checkEqual("and none of it was sent", flowPosts().length, postsBefore);

  /* ---------------------------------------------------------------- */
  step("A two-level flow across two queues");

  const addedBefore = flowPosts().length;
  check("Add flow opens the dialog again", await openDialog());
  check(
    "a top job, a child picked into warehouse, a child in its parent's queue",
    await buildFlow(""),
  );
  const built = await view.evaluate<NodeView[] | null>(
    treeWhen(
      `tree.length === 3 && tree[1].queue === ${JSON.stringify(WAREHOUSE)}`,
    ),
  );
  checkEqual(
    "the dialog shows the tree: each node's name and queue",
    built?.map((node) => [node.label, node.name, node.queue, node.refused]),
    [
      ["Top job", "build-report", REPORTS, null],
      ["Child 1", "count-stock", WAREHOUSE, null],
      ["Child 2", "total-sales", "", null],
    ],
  );
  check(
    "Add flow sends it",
    await view.evaluate<boolean>(button("dialog[open]", "Add flow", true)),
  );
  const added = await view.evaluate<ResultView | null>(resultOf());
  show("the dialog's result", added);
  const [sent] = flowPosts().slice(-1);
  checkEqual(
    "one POST /queues/reports/flows, the child in warehouse naming its queue and the other inheriting reports",
    [flowPosts().length - addedBefore, sent?.status, sent?.body],
    [
      1,
      201,
      {
        name: "build-report",
        data: { month: "2026-09" },
        children: [
          { name: "count-stock", data: { site: "north" }, queue: WAREHOUSE },
          { name: "total-sales", data: { region: "emea" } },
        ],
      },
    ],
  );
  checkEqual(
    "the result lists the three jobs added, each in its queue",
    added?.jobs.map(([name, queue]) => [name, queue]),
    [
      ["build-report", REPORTS],
      ["count-stock", WAREHOUSE],
      ["total-sales", REPORTS],
    ],
  );
  checkEqual(
    "read back through the API: the top job waits on both children, each in its queue with the top job as its parent",
    await readFlow(added),
    {
      top: [REPORTS, "build-report", "waiting-children", 2, true],
      children: [
        [WAREHOUSE, "count-stock", "waiting", 0],
        [REPORTS, "total-sales", "waiting", 0],
      ],
    },
  );
  check(
    "Done closes the dialog",
    (await view.evaluate<boolean>(button("dialog[open]", "Done", true))) &&
      (await view.evaluate<boolean>(
        poll(`!document.querySelector("dialog[open]")`),
      )),
  );

  /* ---------------------------------------------------------------- */
  step("A child going to a queue this caller may not add to");

  checkEqual(
    "payroll's own permissions map says jobs.add: false (reports' says true)",
    [
      (
        await read<PermissionsDto>(
          full.basePath,
          `/meta/permissions?queue=${PAYROLL}`,
        )
      ).actions["jobs.add"],
      (
        await read<PermissionsDto>(
          full.basePath,
          `/meta/permissions?queue=${REPORTS}`,
        )
      ).actions["jobs.add"],
    ],
    [false, true],
  );
  check("Add flow opens the dialog", await openDialog());
  check(
    "the same flow, the second child's queue typed as payroll",
    await buildFlow(PAYROLL),
  );
  check(
    "and a child under it, left in its parent's queue",
    await runSteps([
      button(NODES, "Add child to Child 2", true),
      setNode(3, "Name", "count-stock"),
      setNode(3, "Data", GRANDCHILD_DATA),
    ]),
  );
  const marked = await view.evaluate<NodeView[] | null>(
    treeWhen(
      `tree.length === 4 && tree[2].refused === "true" && tree[3].refused === "true"`,
    ),
  );
  checkEqual(
    "only the jobs going to payroll are marked data-refused, that child and the one taking its queue, each with the message under its queue",
    marked?.map((node) => [node.label, node.refused, node.errors]),
    [
      ["Top job", null, []],
      ["Child 1", null, []],
      ["Child 2", "true", [PRECHECK]],
      ["Child 2.1", "true", [PRECHECK]],
    ],
  );
  check(
    "after the dialog asked payroll's own map (GET /meta/permissions?queue=payroll)",
    exchanges.some(
      (one) =>
        one.path === "/meta/permissions" && one.query === `queue=${PAYROLL}`,
    ),
  );

  const totalsBefore = await storeTotals([REPORTS, WAREHOUSE, PAYROLL]);
  const refusedBefore = flowPosts().length;
  const asksBefore = payrollRefusals;
  check(
    "Add flow is still enabled, and sends it",
    await view.evaluate<boolean>(button("dialog[open]", "Add flow", true)),
  );
  await waitFor(
    "the flow to reach the API",
    () => flowPosts().length > refusedBefore,
  );
  const refusal = flowPosts().at(-1);
  const problem = refusal?.json as ProblemDto | undefined;
  checkEqual(
    "it went out, and the API answered 403 FORBIDDEN naming payroll in context.queue",
    [refusal?.status, problem?.code, problem?.context?.queue],
    [403, "FORBIDDEN", PAYROLL],
  );
  checkEqual(
    "authorize was asked about jobs.add on payroll once for it, and refused",
    payrollRefusals - asksBefore,
    1,
  );
  const afterRefusal = await view.evaluate<NodeView[] | null>(
    treeWhen(
      `tree[2]?.errors.includes(${JSON.stringify(REFUSED)}) && tree[3]?.errors.includes(${JSON.stringify(REFUSED)})`,
    ),
  );
  checkEqual(
    "the dialog shows the refusal on the Queue field of both jobs going to payroll, and no result",
    [
      afterRefusal?.[2]?.errors,
      afterRefusal?.[3]?.errors,
      await view.evaluate<boolean>(
        `!document.querySelector('[data-testid="flow-result"]') && !document.querySelector("dialog[open] .problem-banner")`,
      ),
    ],
    [[REFUSED], [REFUSED], true],
  );
  checkEqual(
    "and keeps the tree as typed: every node's name, data and queue",
    afterRefusal?.map((node) => [
      node.label,
      node.name,
      node.data,
      node.queue,
      node.otherQueue,
    ]),
    [
      ["Top job", "build-report", '{"month":"2026-09"}', REPORTS, null],
      ["Child 1", "count-stock", '{"site":"north"}', WAREHOUSE, null],
      ["Child 2", "total-sales", '{"region":"emea"}', "\u0000other", PAYROLL],
      ["Child 2.1", "count-stock", GRANDCHILD_DATA, "", null],
    ],
  );
  checkEqual(
    "nothing was written: the store's totals for reports, warehouse and payroll are unchanged",
    await storeTotals([REPORTS, WAREHOUSE, PAYROLL]),
    totalsBefore,
  );

  /* ---------------------------------------------------------------- */
  step("A refusal shows while the job still goes where it was sent");

  const editsBefore = flowPosts().length;
  check(
    "the refused child's data edited, its queue left alone",
    (await view.evaluate<boolean | null>(setNode(2, "Data", EDITED_DATA))) ===
      true,
  );
  const dataEdited = await view.evaluate<NodeView[] | null>(
    treeWhen(`tree[2]?.data === ${JSON.stringify(EDITED_DATA)}`),
  );
  checkEqual(
    "both refusals stay: an untouched queue keeps the API's message, on the child and on the one taking its queue",
    [dataEdited?.[2]?.data, dataEdited?.[2]?.errors, dataEdited?.[3]?.errors],
    [EDITED_DATA, [REFUSED], [REFUSED]],
  );

  check(
    "the child's queue retyped as archive, a queue nobody has used yet",
    (await view.evaluate<boolean | null>(
      setNode(2, "Another queue", ARCHIVE),
    )) === true,
  );
  // The new name is asked about once it has settled, through archive's own
  // map, exactly as payroll was.
  /** Whether the page has asked archive's own permissions map. */
  const askedArchive = (): boolean =>
    exchanges.some(
      (one) =>
        one.path === "/meta/permissions" && one.query === `queue=${ARCHIVE}`,
    );
  await waitFor("the dialog to ask archive's own map", askedArchive);
  const fixed = await view.evaluate<NodeView[] | null>(
    treeWhen(
      `tree[2]?.otherQueue === ${JSON.stringify(ARCHIVE)} && !tree[2].errors.includes(${JSON.stringify(PRECHECK)})`,
    ),
  );
  checkEqual(
    "once archive's map allows jobs.add, neither the child nor the one taking its queue is marked data-refused",
    [fixed?.[2]?.otherQueue, fixed?.[2]?.refused, fixed?.[3]?.refused],
    [ARCHIVE, null, null],
  );
  // The API's refusal was about payroll, and neither job goes there now. A
  // refusal that stays fails this check once the wait runs out, showing the
  // tree as it is then.
  const cleared =
    (await view.evaluate<NodeView[] | null>(
      treeWhen(
        `tree.length === 4 && !tree[2].errors.includes(${JSON.stringify(REFUSED)}) && !tree[3].errors.includes(${JSON.stringify(REFUSED)})`,
      ),
    )) ?? (await view.evaluate<NodeView[]>(READ_TREE));
  checkEqual(
    "the refusal is gone from the child and from the one taking its queue, before anything is sent again",
    [
      cleared?.[2]?.errors,
      cleared?.[3]?.errors,
      flowPosts().length - editsBefore,
    ],
    [[], [], 0],
  );
  checkEqual(
    "and neither node's text still contains it",
    await view.evaluate<boolean[]>(
      `[...document.querySelectorAll(${JSON.stringify(NODES)})].slice(2).map((node) => node.textContent.includes(${JSON.stringify(REFUSED)}))`,
    ),
    [false, false],
  );

  /* ---------------------------------------------------------------- */
  step("Send the fixed flow again");

  const fixBefore = flowPosts().length;
  check(
    "Add flow sends it again",
    await view.evaluate<boolean>(button("dialog[open]", "Add flow", true)),
  );
  const resent = await view.evaluate<ResultView | null>(resultOf());
  show("the dialog's result", resent);
  const resentPost = flowPosts().at(-1);
  const resentBody = resentPost?.body as AddFlowBody | undefined;
  checkEqual(
    "one more POST, answered 201, with the child now in archive, its edited data, and its own child naming no queue",
    [
      flowPosts().length - fixBefore,
      resentPost?.status,
      resentBody?.children?.[1]?.queue,
      resentBody?.children?.[1]?.data,
      resentBody?.children?.[1]?.children?.[0]?.queue,
    ],
    [1, 201, ARCHIVE, JSON.parse(EDITED_DATA), undefined],
  );
  checkEqual(
    "read back through the API: the flow is there, the second child in archive and its own child there with it",
    await readFlow(resent),
    {
      top: [REPORTS, "build-report", "waiting-children", 2, true],
      children: [
        [WAREHOUSE, "count-stock", "waiting", 0],
        [ARCHIVE, "total-sales", "waiting-children", 0],
        [ARCHIVE, "count-stock", "waiting", 2],
      ],
    },
  );
  checkEqual(
    "and still not one job in payroll",
    (await storeTotals([PAYROLL]))[PAYROLL],
    0,
  );
  check(
    "Done closes the dialog",
    await view.evaluate<boolean>(button("dialog[open]", "Done", true)),
  );
} catch (error) {
  console.log(`page console:\n${pageConsole.join("\n")}`);
  throw error;
} finally {
  await shutdown(view);
}

summary();
