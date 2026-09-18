/**
 * A seeded demo of the queue screens: several queues with jobs in every
 * state, served with the UI so you can click through it.
 *
 * ```bash
 * bun 05-demo/seeded-demo.ts --serve                  # seed, serve, print every screen's URL
 * PORT=3000 bun 05-demo/seeded-demo.ts --serve        # on a fixed port
 * EXAMPLE_DRIVER=sqlite bun 05-demo/seeded-demo.ts --serve   # on a temp SQLite file
 * bun 05-demo/seeded-demo.ts                          # seed, check it through the API, exit
 * ```
 *
 * This is the one to run if you want to see the UI. `--serve` seeds the
 * queues (see `helpers/seed.ts`), mounts the API and the UI on one adapter,
 * and prints a URL for every screen and panel: the queue list, each queue,
 * a filtered tab, each panel, and jobs that are completed, dead with a
 * `cause`, failed and waiting to retry, running and logging, delayed, a flow's
 * parent, and one whose id holds a `/`. While it serves, a delivery is added to
 * `webhooks` every 3 s and the running job logs a line every 2 s, so the
 * screens have something to refresh on their 5 s poll.
 *
 * Without `--serve` it checks the seed through the API, the same reads the
 * screens make, and exits, so `bun run-all.ts` runs it too.
 *
 * Worth knowing:
 *
 * - **Stack traces are hidden by default.** The API sends a failure's `stack`
 *   only with `serialize: { exposeStacks: true }`, which this demo sets. In
 *   production that exposes file paths to anyone who may read jobs.
 * - **`Add job` and `Update` are opt-in.** `jobs.add` and `jobs.update` write
 *   caller-supplied payloads, so `actions` must name them, and `addableNames`
 *   limits which names may be added (`null` in `/meta` means any).
 * - **`Add job` can create a queue.** Adding the first job to a queue the
 *   backend does not know yet creates it, as `BunQueue.add` does; only a
 *   configured `queues` list makes an unknown queue a 404. The queues here
 *   are seeded from code so each has jobs in every state.
 * - **Every action is allowed here.** `04-screens/permissions.ts` shows a host
 *   that decides per queue, and what the screens then hide.
 */
import type {
  JobDto,
  JobState,
  MetaDto,
  QueueSummaryDto,
} from "@kingsleyweb/bun-jobs";
import process from "node:process";
import { BunHttpAdapter, noopLogger } from "@kingsleyweb/bun-common";
import {
  BunJobs,
  createJobsApi,
  JOBS_API_ACTIONS,
} from "@kingsleyweb/bun-jobs";
import { jobsUi } from "@kingsleyweb/bun-jobs-ui";
import {
  exampleBackend,
  exampleDriver,
  exampleNamespace,
} from "../shared/backend";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";
import { DEMO_IDS, EXPECTED_COUNTS, seedDemo } from "./helpers/seed";

/** Keep serving after the checks, for a browser. */
const serve = process.argv.includes("--serve");

title(`A seeded demo of the queue screens (${exampleBackend()})`);

/* ------------------------------------------------------------------ */
step("Seeding the queues");

const jobs = new BunJobs({
  namespace: exampleNamespace("examples-ui-demo"),
  driver: exampleDriver(),
  // Live events for the API's socket (the Events screen arrives later).
  publishEvents: true,
  logger: noopLogger,
});

const started = performance.now();
const demo = await seedDemo(jobs, { live: serve });
show(`seeded in ${(performance.now() - started).toFixed(0)}ms`);

/* ------------------------------------------------------------------ */
step("The API and the UI, on one adapter");

const api = createJobsApi({
  jobs,
  basePath: "/jobs-api",
  // A real host decides from a session. See 04-screens/permissions.ts.
  authorize: () => true,
  // Every action, including the opt-ins behind `Add job` and `Update`.
  actions: [...JOBS_API_ACTIONS],
  addableNames: ["send-email", "deliver"],
  // The UI reads this from `api.info` and sends the header on every mutation.
  csrf: { header: "x-bun-jobs-csrf" },
  // The failure panels show `stack` only when the API sends it.
  serialize: { exposeStacks: true },
  // Queue state straight from the backend, so Pause shows at once.
  limits: { queueCacheMs: 0 },
  logger: noopLogger,
});
const ui = jobsUi({ api, title: "Jobs demo", logger: noopLogger });

const app = new BunHttpAdapter();
app.use(api.basePath, api.router);
app.use(ui.basePath, ui.router);
api.websocket?.attach(app);

/** A JSON read through the real pipeline, as the screens make it. */
async function read<T>(path: string): Promise<T> {
  const response = await app.fetch(`${api.basePath}${path}`);
  if (response.status !== 200) {
    throw new Error(
      `GET ${path} → ${response.status}: ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
}

/** A job's path segment: the id percent-encoded as one segment. */
const idSegment = (id: string) => encodeURIComponent(id);

/* ------------------------------------------------------------------ */
step("/queues — the queue list");

const list = await read<{ items: QueueSummaryDto[] }>("/queues");
checkEqual(
  "every seeded queue is listed",
  list.items.map((queue) => queue.name).sort(),
  Object.keys(EXPECTED_COUNTS).sort(),
);
const searched = await read<{ items: QueueSummaryDto[] }>(
  "/queues?search=MAIL",
);
checkEqual(
  "search is case-insensitive (?search=MAIL)",
  searched.items.map((queue) => queue.name),
  ["mail"],
);
const firstPage = await read<{
  items: QueueSummaryDto[];
  page: { hasMore: boolean };
}>("/queues?limit=2");
checkEqual(
  "and pages (?limit=2)",
  [firstPage.items.length, firstPage.page.hasMore],
  [2, true],
);

/* ------------------------------------------------------------------ */
step("/queues/:queue — counts per state, the header and tabs");

for (const [queue, expected] of Object.entries(EXPECTED_COUNTS)) {
  checkEqual(
    `${queue}: /counts`,
    await read<Record<JobState, number>>(`/queues/${queue}/counts`),
    { ...expected },
  );
}
checkEqual(
  "reports is paused, mail is not (the header's badge, Resume vs Pause)",
  [
    (await read<{ paused: boolean }>("/queues/reports")).paused,
    (await read<{ paused: boolean }>("/queues/mail")).paused,
  ],
  [true, false],
);

// The jobs table's filters, as the UI sends them from its URL.
const reportsPage = await read<{
  items: JobDto[];
  page: { total?: number; hasMore: boolean };
}>("/queues/reports/jobs?state=waiting&offset=40&limit=20&total=true");
checkEqual(
  "reports, the third page of 20 (?offset=40&limit=20&total=1)",
  [reportsPage.items.length, reportsPage.page.total, reportsPage.page.hasMore],
  [5, 45, false],
);
const named = await read<{ items: JobDto[] }>(
  "/queues/reports/jobs?name=weekly-report&limit=100",
);
checkEqual("reports, ?name=weekly-report", named.items.length, 15);
const newest = await read<{ items: JobDto[] }>(
  "/queues/mail/jobs?state=completed&order=desc&search=invoice",
);
checkEqual(
  "mail, completed, ?search=invoice&order=desc",
  newest.items.map((job) => job.id),
  [DEMO_IDS.slashed],
);

/* ------------------------------------------------------------------ */
step("/queues/:queue?panel=… — limits, workers, throughput, repeatables");

const meta = await read<MetaDto>("/meta");
show("features", meta.features);

if (meta.features.limits) {
  const limits = await read<{ limits: unknown }>("/queues/mail");
  show("mail limits", limits.limits);
  check("panel=limits: mail has limits set", limits.limits !== null, limits);
}
if (meta.features.workers) {
  const workers = await read<{
    items: { queue: string; concurrency: number }[];
  }>("/workers");
  checkEqual(
    "panel=workers: one worker each on mail and webhooks",
    workers.items.map((worker) => [worker.queue, worker.concurrency]).sort(),
    [
      ["mail", 1],
      ["webhooks", 2],
    ],
  );
}
if (meta.features.throughput) {
  const throughput = await read<{
    buckets: { completed: number; failed: number }[];
  }>("/queues/mail/throughput?minutes=15");
  const completed = throughput.buckets.reduce(
    (sum, bucket) => sum + bucket.completed,
    0,
  );
  const failed = throughput.buckets.reduce(
    (sum, bucket) => sum + bucket.failed,
    0,
  );
  checkEqual(
    "panel=throughput: mail's three completions and two failed attempts",
    [completed, failed],
    [3, 2],
  );
}
const repeatables = await read<{
  items: { key: string; nextJobId: string | null }[];
}>("/queues/mail/repeatables");
checkEqual(
  "panel=repeatables: the weekly digest",
  repeatables.items.map((item) => item.key),
  ["weekly-digest"],
);

/* ------------------------------------------------------------------ */
step("/queues/:queue/jobs/:id — the job screen");

const dead = await read<JobDto>(
  `/queues/mail/jobs/${idSegment(DEMO_IDS.dead)}?include=data,returnValue,stacktrace,opts`,
);
show("a dead job's failure", dead.failedReason);
checkEqual(
  "the dead job: state, attempts, the failure and its cause",
  [
    dead.state,
    dead.attemptsMade,
    dead.failedReason?.message,
    dead.failedReason?.cause?.message,
  ],
  ["dead", 1, "Mailbox unavailable: ada@old.example", "550 5.1.1 user unknown"],
);
check(
  "with its stack (exposeStacks) in the stack traces",
  typeof dead.stacktrace?.[0]?.stack === "string",
  dead.stacktrace,
);
const hook = await read<JobDto>(
  `/queues/webhooks/jobs/${idSegment(DEMO_IDS.webhookDead)}?include=stacktrace`,
);
checkEqual(
  "a job dead after two attempts has two stack traces",
  hook.stacktrace?.length,
  2,
);

const failed = await read<JobDto>(
  `/queues/mail/jobs/${idSegment(DEMO_IDS.failed)}`,
);
checkEqual(
  "the failed job waits for its next attempt",
  [failed.state, failed.attemptsMade, failed.maxAttempts],
  ["failed", 1, 3],
);

if (meta.features.logs) {
  const logs = await read<{ items: string[] }>(
    `/queues/mail/jobs/${idSegment(DEMO_IDS.completed)}/logs`,
  );
  checkEqual("a completed job's logs", logs.items, [
    "connecting to smtp.example.com:587",
    "sent welcome to ada@example.com",
  ]);
  const active = await read<{ items: string[] }>(
    `/queues/mail/jobs/${idSegment(DEMO_IDS.active)}/logs`,
  );
  check(
    "the active job has logged (the screen follows it every 3 s)",
    active.items.length >= 1,
    active,
  );
}

const slashed = await read<JobDto>(
  `/queues/mail/jobs/${idSegment(DEMO_IDS.slashed)}`,
);
checkEqual(
  `an id with a "/" reads back through %2F`,
  [slashed.id, slashed.state, slashed.returnValue],
  [
    DEMO_IDS.slashed,
    "completed",
    { messageId: `<${DEMO_IDS.slashed}@smtp.example.com>` },
  ],
);

const parent = await read<JobDto>(
  `/queues/mail/jobs/${idSegment(DEMO_IDS.flowParent)}`,
);
show("the flow's parent", parent.flow);
checkEqual(
  "the flow's parent waits for its children",
  parent.state,
  "waiting-children",
);
// What the job screen's Flow card reads: the parent, how many children are
// pending, and each child with its job (`null` in a queue the API cannot reach).
const children = await read<{
  parent: unknown;
  pending: number;
  children: { queue: string; job: JobDto | null }[];
}>(`/queues/mail/jobs/${idSegment(DEMO_IDS.flowParent)}/children`);
checkEqual(
  "and its two children are pending, waiting in render",
  [
    children.parent,
    children.pending,
    children.children
      .map((child) => [child.queue, child.job?.name, child.job?.state])
      .sort(),
  ],
  [
    null,
    2,
    [
      ["render", "render-html", "waiting"],
      ["render", "render-text", "waiting"],
    ],
  ],
);

/* ------------------------------------------------------------------ */
step("The UI serves every screen's URL");

/** The screens worth opening, by what they show. */
const screens: [string, string][] = [
  ["the queue list", "/queues"],
  ["the queue list, searched", "/queues?search=re"],
  ["mail: every state", "/queues/mail"],
  [
    "mail: failed tab, workers panel",
    "/queues/mail?state=failed&panel=workers",
  ],
  ["mail: limits panel", "/queues/mail?panel=limits"],
  [
    "mail: throughput, last 15 minutes",
    "/queues/mail?panel=throughput&window=15",
  ],
  ["mail: repeatables panel", "/queues/mail?panel=repeatables"],
  [
    "reports: paused, page 3 with the total",
    "/queues/reports?offset=40&limit=20&total=1",
  ],
  ["webhooks: newest first", "/queues/webhooks?order=desc"],
  [
    "job: completed, with logs",
    `/queues/mail/jobs/${idSegment(DEMO_IDS.completed)}`,
  ],
  [
    "job: dead, with a cause and a stack",
    `/queues/mail/jobs/${idSegment(DEMO_IDS.dead)}`,
  ],
  [
    "job: failed, retrying in an hour",
    `/queues/mail/jobs/${idSegment(DEMO_IDS.failed)}`,
  ],
  ["job: active, logging", `/queues/mail/jobs/${idSegment(DEMO_IDS.active)}`],
  [
    "job: delayed (Promote)",
    `/queues/mail/jobs/${idSegment(DEMO_IDS.delayed)}`,
  ],
  [
    "job: a flow's parent",
    `/queues/mail/jobs/${idSegment(DEMO_IDS.flowParent)}`,
  ],
  [
    "job: two stack traces",
    `/queues/webhooks/jobs/${idSegment(DEMO_IDS.webhookDead)}`,
  ],
  ["job: an id with a /", `/queues/mail/jobs/${idSegment(DEMO_IDS.slashed)}`],
];
for (const [, path] of screens) {
  const response = await app.fetch(`${ui.basePath}${path}`);
  await response.arrayBuffer();
  if (response.status !== 200) {
    checkEqual(`${ui.basePath}${path}`, response.status, 200);
  }
}
check(`all ${screens.length} screen URLs answer 200`, true);

summary();

if (serve) {
  await app.listen(Number(process.env.PORT ?? 0));
  const base = `${app.url}${ui.basePath}`;
  step(`Serving at ${base} — Ctrl+C to stop`);
  const width = Math.max(...screens.map(([label]) => label.length));
  for (const [label, path] of screens) {
    console.log(`  ${label.padEnd(width)}  ${base}${path}`);
  }
  console.log(`\n  the API: ${app.url}${api.basePath}/meta`);

  const stopTrickle = demo.trickle(3_000);
  process.once("SIGINT", async () => {
    stopTrickle();
    await demo.stop();
    await app.close();
    await api.close();
    if (exampleBackend() !== "memory") {
      await jobs.purge();
    }
    await jobs.close();
    process.exit();
  });
} else {
  await demo.stop();
  await api.close();
  if (exampleBackend() !== "memory") {
    // A persistent backend outlives the process: leave nothing behind.
    await jobs.purge();
  }
  await jobs.close();
}
